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
} from '../chat-streams.js';
import { touchThread } from '../threads.js';
import type { PreparedTurn } from './prepare-turn.js';
import { failRunSetup, releaseRunHandles } from './run-cleanup.js';
import { type AcquiredRun, settleUsage } from './run-lifecycle.js';

type RunOutcome = { status: Exclude<ChatRunStatus, 'active'>; error?: string };

async function persistAssistant(
  { thread, user }: PreparedTurn,
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
  let persistenceFailure: { error: unknown } | undefined;
  try {
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
  } catch (error) {
    persistenceFailure = { error };
  }
  // Attempt both operations, but never replace the initiating persistence error
  // with a secondary settlement error. Report the latter separately.
  try {
    await settleUsage(reservation, usage ?? null);
  } catch (error) {
    logger.error(
      { error, threadId: thread.id, reservationId: reservation?.id },
      'Failed to settle chat usage',
    );
    if (!persistenceFailure) throw error;
  }
  if (persistenceFailure) throw persistenceFailure.error;
}

/** Start the provider and compose its persisted, resumable SDK response. */
export async function streamResponse(turn: PreparedTurn, run: AcquiredRun) {
  const { input, thread, resolved, uiMessages, system, sourceParts, searchGroundingPart } = turn;
  const { runIdentity, assistantMessage, persistence } = run;
  const abortController = new AbortController();
  let modelStarted = false;
  let setupFailed = false;
  let completion: Promise<void> | undefined;
  let captureStarted = false;
  let outcome: RunOutcome = { status: 'complete' };
  try {
    const messages = await convertToModelMessages(uiMessages);
    registerLocalChatRun(runIdentity, abortController);
    let modelFailed = false;
    let lastCancellationCheck = 0;
    const result = streamText({
      model: resolved.languageModel,
      system,
      messages,
      abortSignal: abortController.signal,
      ...turn.generationSettings,
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

    modelStarted = true;
    const responseStream = createUIMessageStream({
      originalMessages: uiMessages,
      generateId: () => assistantMessage.id,
      execute: ({ writer }) => {
        // Attribute the reply while it streams, not only after reloading storage.
        writer.write({
          type: 'start',
          messageMetadata: { modelSlug: resolved.slug, effort: input.effort ?? null },
        });
        if (turn.contextLimited)
          writer.write({ type: 'data-context-window', data: { limited: true } });
        if (searchGroundingPart) writer.write(searchGroundingPart);
        if (turn.projectSearchPart) writer.write(turn.projectSearchPart);
        for (const source of sourceParts) writer.write(source);
        writer.merge(
          result.toUIMessageStream({
            originalMessages: uiMessages,
            sendStart: false,
          }),
        );
      },
      onEnd: ({ responseMessage, isAborted }) => {
        if (setupFailed) return;
        completion ??= (async () => {
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
            await releaseRunHandles(run);
          }
        })();
        return completion;
      },
    });

    return createUIMessageStreamResponse({
      stream: responseStream,
      headers: {
        'X-OCI-Chat-Run-Id': runIdentity.runId,
        'X-OCI-Prompt-Message-Id': turn.promptMessageId,
        'X-OCI-Stream-Persistence': persistence === 'available' ? 'redis' : 'unavailable',
      },
      ...(persistence === 'available'
        ? {
            consumeSseStream: ({ stream }: { stream: ReadableStream<string> }) => {
              // The SDK starts this consumer before constructing the Response.
              // Once started it exclusively owns Redis finalization, even if
              // response construction subsequently throws.
              captureStarted = true;
              return captureChatRun(runIdentity, stream, () => outcome);
            },
          }
        : {}),
    });
  } catch (error) {
    setupFailed = true;
    outcome = { status: 'error', error: 'Stream setup failed' };
    abortController.abort('setup-failed');
    // If SDK completion already began, let its measured usage settle first.
    await completion;
    await failRunSetup(run, { modelStarted, abandon: !captureStarted });
    throw error;
  }
}
