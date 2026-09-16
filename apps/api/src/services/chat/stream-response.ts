import { and, eq, schema } from '@oci/db';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from 'ai';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import {
  type ChatRunStatus,
  captureChatRun,
  isChatRunCancellationRequested,
  registerLocalChatRun,
  unregisterLocalChatRun,
} from '../chat-streams.js';
import { reasoningCallSettings } from '../reasoning.js';
import { touchThread } from '../threads.js';
import type { PreparedTurn } from './prepare-turn.js';
import { type AcquiredRun, settleUsage } from './run-lifecycle.js';

type RunOutcome = { status: Exclude<ChatRunStatus, 'active'>; error?: string };

async function persistAssistant(
  { thread, user, resolved }: PreparedTurn,
  { assistantMessage, startedAt, reservation }: AcquiredRun,
  responseMessage: UIMessage,
  status: RunOutcome['status'],
  getUsage: () => ReturnType<typeof streamText>['usage'],
) {
  let usage: Awaited<ReturnType<typeof getUsage>> | undefined;
  try {
    usage = await getUsage();
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
  // Settle even without provider usage: cancelled/failed runs count toward a message quota.
  await settleUsage(reservation, usage ?? null, { userId: user.id, modelSlug: resolved.slug });
}

/** Start the provider and compose its persisted, resumable SDK response. */
export async function streamResponse(turn: PreparedTurn, run: AcquiredRun) {
  const { input, thread, resolved, uiMessages, system, sourceParts, searchGroundingPart } = turn;
  const { runIdentity, assistantMessage, streamSlot, persistence } = run;
  const abortController = new AbortController();
  registerLocalChatRun(runIdentity, abortController);
  let modelFailed = false;
  let lastCancellationCheck = 0;
  let outcome: RunOutcome = { status: 'complete' };
  const result = streamText({
    model: resolved.languageModel,
    system,
    messages: await convertToModelMessages(uiMessages),
    abortSignal: abortController.signal,
    ...(resolved.maxOutputTokens ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
    ...reasoningCallSettings(input.effort, resolved.providerKind),
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
      // Attribute the reply while it streams, not only after reloading storage.
      writer.write({
        type: 'start',
        messageMetadata: { modelSlug: resolved.slug, effort: input.effort ?? null },
      });
      if (searchGroundingPart) writer.write(searchGroundingPart);
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
        await persistAssistant(turn, run, responseMessage, status, () => result.usage);
      } catch (error) {
        outcome = { status: 'error', error: 'Assistant message persistence failed' };
        logger.error(
          { error, threadId: thread.id, runId: runIdentity.runId },
          'Failed to persist assistant message',
        );
      } finally {
        // Release on generation end, not response close: clients may disconnect
        // and resume the same run while it continues generating.
        await streamSlot.release();
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
}
