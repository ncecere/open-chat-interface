import { and, eq, inArray, isNull, schema } from '@oci/db';
import { sendMessageSchema } from '@oci/shared';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
} from 'ai';
import { Hono } from 'hono';
import { db } from '../db/index.js';
import { conflict, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { loadAttachmentsForMessage } from '../services/attachments/index.js';
import {
  abandonChatRun,
  beginChatRun,
  type ChatRunStatus,
  cancelActiveChatRun,
  captureChatRun,
  isChatRunCancellationRequested,
  registerLocalChatRun,
  resumeActiveChatRun,
  unregisterLocalChatRun,
} from '../services/chat-streams.js';
import { resolveModelForRole } from '../services/models.js';
import { assertPersonasAllowed, getOwnedPersona } from '../services/personas.js';
import { checkQuota, recordUsage } from '../services/quota/index.js';
import { buildGroundingContext, searchWeb } from '../services/search/index.js';
import { buildSystemPrompt } from '../services/system-prompt.js';
import {
  assertTemporaryChatAllowed,
  deriveTitle,
  getOwnedThread,
  listMessages,
  nextPosition,
  touchThread,
} from '../services/threads.js';

export const chatRoutes = new Hono<AppBindings>();

chatRoutes.use('*', requireAuth);

/** Reasoning effort maps to provider-specific options at call time. */
const EFFORT_BUDGETS: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 24576,
};

function textParts(parts: unknown): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(parts)) return [];

  return parts.flatMap((part) =>
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
      ? [{ type: 'text' as const, text: (part as { text: string }).text }]
      : [],
  );
}

function textFromParts(parts: unknown): string {
  return textParts(parts)
    .map((part) => part.text)
    .join('\n');
}

chatRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, sendMessageSchema);

  const thread = await getOwnedThread(input.threadId, user.id);
  if (input.temporary && !thread.temporary) {
    throw validationFailed('Temporary mode must be selected when the thread is created');
  }
  if (thread.temporary) await assertTemporaryChatAllowed(user.role);

  const requestedPersonaId = input.personaId === undefined ? thread.personaId : input.personaId;
  const selectedPersona = requestedPersonaId
    ? await (async () => {
        await assertPersonasAllowed(user.role);
        return getOwnedPersona(requestedPersonaId, user.id, user.organizationId);
      })()
    : null;

  if (input.personaId !== undefined && input.personaId !== thread.personaId) {
    await db
      .update(schema.thread)
      .set({ personaId: selectedPersona?.id ?? null })
      .where(and(eq(schema.thread.id, thread.id), eq(schema.thread.userId, user.id)));
  }

  await checkQuota(user.id, user.role);

  const resolved = await resolveModelForRole(input.modelSlug, user.role);
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
    if (input.attachmentIds.length > 0) {
      throw validationFailed('Attachments cannot be added while regenerating a response');
    }

    const targetIndex = storedMessages.findIndex((message) => message.id === latest.id);
    const target = storedMessages[targetIndex];
    if (target?.role !== 'user') {
      throw validationFailed('The regeneration target must be a user message in this thread');
    }
    if (textFromParts(target.parts) !== textFromParts(latest.parts)) {
      throw validationFailed('The stored user message cannot be changed during regeneration');
    }

    // A regeneration uses only server-owned history through the target turn.
    // Later turns remain stored and are never rewritten or deleted.
    contextMessages = storedMessages.slice(0, targetIndex + 1);
    promptMessageId = target.id;
    latest = { id: target.id, role: 'user', parts: textParts(target.parts) };
  }

  const [attachments, searchResults] = await Promise.all([
    loadAttachmentsForMessage(input.attachmentIds, user.id, user.role),
    input.webSearch ? searchWeb(textFromParts(latest.parts)) : Promise.resolve([]),
  ]);

  // Never trust client-supplied history. Rebuild bounded text-only context from
  // messages owned by this thread, then append only a validated new turn.
  const uiMessages: UIMessage[] = contextMessages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const parts = textParts(message.parts);
    return parts.length > 0 ? [{ id: message.id, role: message.role, parts }] : [];
  });
  if (input.trigger === 'submit-message') uiMessages.push(latest);

  // Persist a submitted user turn before streaming so a dropped connection
  // cannot lose it. Regeneration points at an existing immutable user row.
  if (input.trigger === 'submit-message') {
    const position = await nextPosition(thread.id);

    // Record attachments on the turn so the conversation still shows them
    // after a reload. Bytes are never stored in the message itself.
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
    promptMessageId = stored.id;
    submittedMessageId = stored.id;

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
  }

  // Attachments are appended to the final user turn for the model: images as
  // file parts for vision models, documents as extracted text.
  if (attachments.length > 0) {
    const supportsVision = resolved.capabilities.includes('vision');
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

  if (input.webSearch) {
    latest.parts = [
      ...latest.parts,
      { type: 'text', text: buildGroundingContext(searchResults) },
    ] as typeof latest.parts;
  }

  if (input.trigger === 'regenerate-message') {
    uiMessages[uiMessages.length - 1] = latest;
  }

  // The persona reaches the prompt builder only after an owner-scoped lookup.
  const system = await buildSystemPrompt(user.id, user.name, selectedPersona);
  const sourceParts = searchResults.map((source, index) => ({
    type: 'source-url' as const,
    sourceId: `search-${index + 1}`,
    url: source.url,
    title: source.title,
  }));
  const startedAt = Date.now();
  const runIdentity = {
    runId: crypto.randomUUID(),
    threadId: thread.id,
    userId: user.id,
  };
  const persistence = await beginChatRun(runIdentity);
  if (persistence === 'conflict') {
    // The user turn was written before generation. Roll it back when another
    // run won the per-thread Redis lock so retrying cannot duplicate it.
    if (submittedMessageId) {
      await db
        .delete(schema.message)
        .where(
          and(
            eq(schema.message.id, submittedMessageId),
            eq(schema.message.threadId, thread.id),
            eq(schema.message.userId, user.id),
          ),
        );
    }
    throw conflict('A response is already being generated for this thread');
  }

  let assistantMessage: { id: string };
  try {
    const position = await nextPosition(thread.id);
    const [inserted] = await db
      .insert(schema.message)
      .values({
        threadId: thread.id,
        userId: user.id,
        role: 'assistant',
        parts: [],
        position,
        parentMessageId: promptMessageId,
        modelSlug: resolved.slug,
        effort: input.effort ?? null,
        webSearchUsed: input.webSearch,
        status: 'streaming',
      })
      .returning({ id: schema.message.id });
    if (!inserted) throw new Error('Failed to create assistant message');
    assistantMessage = inserted;
  } catch (error) {
    if (persistence === 'available') await abandonChatRun(runIdentity);
    throw error;
  }

  const abortController = new AbortController();
  registerLocalChatRun(runIdentity, abortController);
  let modelFailed = false;
  let lastCancellationCheck = 0;
  let outcome: { status: Exclude<ChatRunStatus, 'active'>; error?: string } = {
    status: 'complete',
  };
  const budget = input.effort ? EFFORT_BUDGETS[input.effort] : undefined;

  const result = streamText({
    model: resolved.languageModel,
    system,
    messages: await convertToModelMessages(uiMessages),
    abortSignal: abortController.signal,
    ...(resolved.maxOutputTokens ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
    ...(budget
      ? {
          providerOptions: {
            anthropic: { thinking: { type: 'enabled', budgetTokens: budget } },
            openai: { reasoningEffort: input.effort },
            google: { thinkingConfig: { thinkingBudget: budget } },
          },
        }
      : {}),
    onChunk: async () => {
      if (Date.now() - lastCancellationCheck < 500) return;
      lastCancellationCheck = Date.now();
      if (await isChatRunCancellationRequested(runIdentity.runId)) {
        abortController.abort('user-stop');
      }
    },
    onError: ({ error }) => {
      modelFailed = true;
      logger.error(
        { error, modelSlug: resolved.slug, runId: runIdentity.runId },
        'Model stream failed',
      );
    },
  });

  const responseStream = createUIMessageStream({
    originalMessages: uiMessages,
    generateId: () => assistantMessage.id,
    execute: ({ writer }) => {
      writer.write({ type: 'start' });
      for (const source of sourceParts) writer.write(source);
      writer.merge(
        result.toUIMessageStream({
          originalMessages: uiMessages,
          sendStart: false,
        }),
      );
    },
    onEnd: async ({ responseMessage, isAborted }) => {
      const status = isAborted ? 'cancelled' : modelFailed ? 'error' : 'complete';
      outcome = {
        status,
        ...(status === 'error' ? { error: 'The model stream failed' } : {}),
      };

      try {
        let usage: Awaited<typeof result.usage> | undefined;
        try {
          usage = await result.usage;
        } catch {
          usage = undefined;
        }
        await db
          .update(schema.message)
          .set({
            parts: responseMessage.parts as unknown as Record<string, unknown>[],
            status,
            errorMessage: status === 'error' ? 'The model failed to generate a response' : null,
            tokensIn: usage?.inputTokens ?? null,
            tokensOut: usage?.outputTokens ?? null,
            durationMs: Date.now() - startedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.message.id, assistantMessage.id),
              eq(schema.message.threadId, thread.id),
              eq(schema.message.userId, user.id),
            ),
          );

        await touchThread(thread.id);
        if (usage) {
          await recordUsage({
            userId: user.id,
            modelSlug: resolved.slug,
            tokensIn: usage.inputTokens ?? 0,
            tokensOut: usage.outputTokens ?? 0,
          });
        }
      } catch (error) {
        outcome = { status: 'error', error: 'Assistant message persistence failed' };
        logger.error(
          { error, threadId: thread.id, runId: runIdentity.runId },
          'Failed to persist assistant message',
        );
      } finally {
        if (persistence !== 'available') unregisterLocalChatRun(runIdentity.runId);
      }
    },
  });

  return createUIMessageStreamResponse({
    stream: responseStream,
    headers: {
      'X-OCI-Chat-Run-Id': runIdentity.runId,
      'X-OCI-Stream-Persistence': persistence === 'available' ? 'redis' : 'unavailable',
    },
    ...(persistence === 'available'
      ? {
          consumeSseStream: ({ stream }: { stream: ReadableStream<string> }) =>
            captureChatRun(runIdentity, stream, () => outcome),
        }
      : {}),
  });
});

/** Replays the active SSE stream after authenticating the thread owner. */
chatRoutes.get('/:threadId/stream', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const resumed = await resumeActiveChatRun(thread.id, user.id, c.req.raw.signal);
  if (!resumed) return c.body(null, 204);

  return new Response(resumed.stream, {
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      'X-OCI-Stream-Persistence': resumed.persistence,
    },
  });
});

/** Explicit stop request; also reaches a producer running in another API process via Redis. */
chatRoutes.delete('/:threadId/stream', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const cancelled = await cancelActiveChatRun(thread.id, user.id);
  return c.json({ cancelled });
});

/** Returns stored messages in the AI SDK UI format for hydration. */
chatRoutes.get('/:threadId/messages', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const messages = await listMessages(thread.id);

  return c.json({
    thread: {
      id: thread.id,
      temporary: thread.temporary,
      expiresAt: thread.expiresAt?.toISOString() ?? null,
      personaId: thread.personaId,
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts,
      metadata: {
        modelSlug: message.modelSlug,
        effort: message.effort,
        parentMessageId: message.parentMessageId,
        status: message.status,
        errorMessage: message.errorMessage,
        createdAt: message.createdAt.toISOString(),
      },
    })),
  });
});
