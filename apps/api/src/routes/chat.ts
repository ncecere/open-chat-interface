import { eq, schema } from '@oci/db';
import { sendMessageSchema } from '@oci/shared';
import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { Hono } from 'hono';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { resolveModelForRole } from '../services/models.js';
import { checkQuota, recordUsage } from '../services/quota.js';
import { buildSystemPrompt } from '../services/system-prompt.js';
import {
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

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
    )
    .map((part) => part.text)
    .join('\n');
}

chatRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, sendMessageSchema);

  const thread = await getOwnedThread(input.threadId, user.id);
  await checkQuota(user.id, user.role);

  const resolved = await resolveModelForRole(input.modelSlug, user.role);
  const uiMessages = input.messages as unknown as UIMessage[];
  const latest = uiMessages.at(-1);

  // Persist the user's turn before streaming so a dropped connection cannot
  // lose it.
  if (latest?.role === 'user') {
    const position = await nextPosition(thread.id);

    await db.insert(schema.message).values({
      threadId: thread.id,
      userId: user.id,
      role: 'user',
      parts: latest.parts as unknown as Record<string, unknown>[],
      position,
      modelSlug: resolved.slug,
      effort: input.effort ?? null,
      status: 'complete',
    });

    if (position === 0 && thread.title === 'New Chat') {
      await db
        .update(schema.thread)
        .set({ title: deriveTitle(textFromParts(latest.parts)) })
        .where(eq(schema.thread.id, thread.id));
    }
  }

  const system = await buildSystemPrompt(user.id, user.name);
  const startedAt = Date.now();

  const budget = input.effort ? EFFORT_BUDGETS[input.effort] : undefined;

  const result = streamText({
    model: resolved.languageModel,
    system,
    messages: await convertToModelMessages(uiMessages),
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
    onError: ({ error }) => {
      logger.error({ error, modelSlug: resolved.slug }, 'Model stream failed');
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: uiMessages,
    onFinish: async ({ responseMessage }) => {
      try {
        const position = await nextPosition(thread.id);
        const usage = await result.usage;

        await db.insert(schema.message).values({
          threadId: thread.id,
          userId: user.id,
          role: 'assistant',
          parts: responseMessage.parts as unknown as Record<string, unknown>[],
          position,
          modelSlug: resolved.slug,
          effort: input.effort ?? null,
          webSearchUsed: input.webSearch,
          status: 'complete',
          tokensIn: usage?.inputTokens ?? null,
          tokensOut: usage?.outputTokens ?? null,
          durationMs: Date.now() - startedAt,
        });

        await touchThread(thread.id);
        await recordUsage({
          userId: user.id,
          modelSlug: resolved.slug,
          tokensIn: usage?.inputTokens ?? 0,
          tokensOut: usage?.outputTokens ?? 0,
        });
      } catch (error) {
        logger.error({ error, threadId: thread.id }, 'Failed to persist assistant message');
      }
    },
  });
});

/** Returns stored messages in the AI SDK UI format for hydration. */
chatRoutes.get('/:threadId/messages', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const messages = await listMessages(thread.id);

  return c.json({
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts,
      metadata: { modelSlug: message.modelSlug, createdAt: message.createdAt.toISOString() },
    })),
  });
});
