import { and, eq, inArray, isNull, schema } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import type { AuthenticatedUser } from '../../middleware/context.js';
import { loadAttachmentsForMessage } from '../attachments/index.js';
import { resolveModelForRole } from '../models.js';
import { assertReasoningEffortSupported } from '../reasoning.js';
import { buildGroundingContext, normalizeSearchQuery, searchWeb } from '../search/index.js';
import { buildSystemPrompt } from '../system-prompt.js';
import {
  assertTemporaryChatAllowed,
  deriveTitle,
  getOwnedThread,
  listMessages,
  nextPosition,
} from '../threads.js';
import { regenerationContext, textFromParts, textParts } from './message-parts.js';

type TurnContext = {
  user: Pick<AuthenticatedUser, 'id' | 'name' | 'role'>;
  input: SendMessageInput;
  thread: Awaited<ReturnType<typeof getOwnedThread>>;
  resolved: Awaited<ReturnType<typeof resolveModelForRole>>;
};
type Attachments = Awaited<ReturnType<typeof loadAttachmentsForMessage>>;

export type PreparedTurn = TurnContext & {
  promptMessageId: string;
  submittedMessageId: string | null;
  uiMessages: UIMessage[];
  system: Awaited<ReturnType<typeof buildSystemPrompt>>;
  sourceParts: Array<{ type: 'source-url'; sourceId: string; url: string; title: string }>;
  searchGroundingPart: {
    type: 'data-search-grounding';
    id: string;
    data: { query: string; results: Awaited<ReturnType<typeof searchWeb>> };
  } | null;
};

/** Persist before streaming, including attachment references but never file bytes. */
async function persistUserTurn(
  { user, input, thread, resolved }: TurnContext,
  latest: UIMessage,
  attachments: Attachments,
): Promise<string> {
  const position = await nextPosition(thread.id);
  const attachmentParts = attachments.map((file) => ({
    type: 'data-attachment' as const,
    data: {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      url: `/api/attachments/${file.id}/content`,
    },
  }));

  const [stored] = await db
    .insert(schema.message)
    .values({
      threadId: thread.id,
      userId: user.id,
      role: 'user',
      parts: [...latest.parts, ...attachmentParts] as unknown as Record<string, unknown>[],
      position,
      modelSlug: resolved.slug,
      effort: input.effort ?? null,
      status: 'complete',
    })
    .returning({ id: schema.message.id });

  if (!stored) throw new Error('Failed to persist user message');

  // Link uploads to the turn that sent them so the manager can show usage.
  if (stored && input.attachmentIds.length > 0) {
    await db
      .update(schema.attachment)
      .set({ messageId: stored.id })
      .where(
        and(
          inArray(schema.attachment.id, input.attachmentIds),
          eq(schema.attachment.userId, user.id),
          isNull(schema.attachment.messageId),
        ),
      );
  }

  if (position === 0 && thread.title === 'New Chat') {
    await db
      .update(schema.thread)
      .set({ title: deriveTitle(textFromParts(latest.parts)) })
      .where(eq(schema.thread.id, thread.id));
  }
  return stored.id;
}

/** Model-only enrichment; the saved user turn remains unchanged. */
function appendAttachments(latest: UIMessage, attachments: Attachments, supportsVision: boolean) {
  if (attachments.length === 0) return;
  const extraParts: Record<string, unknown>[] = [];
  for (const attachment of attachments) {
    if (attachment.bytes && supportsVision) {
      extraParts.push({
        type: 'file',
        mediaType: attachment.mimeType,
        filename: attachment.filename,
        url: `data:${attachment.mimeType};base64,${attachment.bytes.toString('base64')}`,
      });
    } else if (attachment.extractedText) {
      extraParts.push({
        type: 'text',
        text: `Attached file "${attachment.filename}":\n\n${attachment.extractedText}`,
      });
    } else {
      extraParts.push({
        type: 'text',
        text: `Attached file "${attachment.filename}" (${attachment.mimeType}) could not be read.`,
      });
    }
  }
  latest.parts = [...latest.parts, ...extraParts] as typeof latest.parts;
}

/** Validate ownership/model, rebuild trusted history, and save/enrich the user turn. */
export async function prepareTurn(
  user: TurnContext['user'],
  input: SendMessageInput,
): Promise<PreparedTurn> {
  const thread = await getOwnedThread(input.threadId, user.id);
  if (input.temporary && !thread.temporary) {
    throw validationFailed('Temporary mode must be selected when the thread is created');
  }
  if (thread.temporary) await assertTemporaryChatAllowed(user.role);

  const resolved = await resolveModelForRole(input.modelSlug, user.role);
  assertReasoningEffortSupported(input.effort, resolved.supportedEfforts);
  const latestInput = input.messages[0];
  if (!latestInput) throw validationFailed('A user message is required');

  let latest: UIMessage = {
    id: latestInput.id ?? crypto.randomUUID(),
    role: 'user',
    parts: latestInput.parts,
  };

  const storedMessages = await listMessages(thread.id);
  let contextMessages = storedMessages;
  let promptMessageId = latest.id;
  let submittedMessageId: string | null = null;

  if (input.trigger === 'regenerate-message') {
    ({ contextMessages, promptMessageId, latest } = regenerationContext(
      storedMessages,
      latest,
      input.attachmentIds,
    ));
  }

  const searchQuery = input.webSearch ? normalizeSearchQuery(textFromParts(latest.parts)) : null;
  const [attachments, searchResults] = await Promise.all([
    loadAttachmentsForMessage(input.attachmentIds, user.id, user.role),
    searchQuery ? searchWeb(searchQuery) : Promise.resolve([]),
  ]);

  // Never trust client-supplied history. Rebuild bounded text-only context from
  // messages owned by this thread, then append only a validated new turn.
  const uiMessages: UIMessage[] = contextMessages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const parts = textParts(message.parts);
    return parts.length > 0 ? [{ id: message.id, role: message.role, parts }] : [];
  });
  if (input.trigger === 'submit-message') uiMessages.push(latest);

  const context = { user, input, thread, resolved };
  if (input.trigger === 'submit-message') {
    promptMessageId = await persistUserTurn(context, latest, attachments);
    submittedMessageId = promptMessageId;
  }

  appendAttachments(latest, attachments, resolved.capabilities.includes('vision'));
  if (input.webSearch) {
    latest.parts = [
      ...latest.parts,
      { type: 'text', text: buildGroundingContext(searchResults) },
    ] as typeof latest.parts;
  }
  if (input.trigger === 'regenerate-message') {
    uiMessages[uiMessages.length - 1] = latest;
  }

  const system = await buildSystemPrompt(user.id, user.name);
  const sourceParts = searchResults.map((source, index) => ({
    type: 'source-url' as const,
    sourceId: `search-${index + 1}`,
    url: source.url,
    title: source.title,
  }));
  const searchGroundingPart = searchQuery
    ? {
        type: 'data-search-grounding' as const,
        id: `search-grounding-${crypto.randomUUID()}`,
        data: { query: searchQuery, results: searchResults },
      }
    : null;

  return {
    ...context,
    promptMessageId,
    submittedMessageId,
    uiMessages,
    system,
    sourceParts,
    searchGroundingPart,
  };
}
