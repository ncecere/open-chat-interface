import { and, eq, schema, sql } from '@oci/db';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { type RetryOptions, retryOnConnectionError } from '../../lib/db-connection.js';
import { logger } from '../../lib/logger.js';
import { saveDetectedArtifacts } from '../artifacts/store.js';
import type { ChatRunStatus } from '../chat-streams.js';
import { touchThread } from '../threads.js';
import type { PreparedTurn } from './prepare-turn.js';
import { type AcquiredRun, settleUsage } from './run-lifecycle.js';
import { INTERRUPTED_REPLY_MESSAGE } from './run-recovery.js';

export type ReplyUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  partial?: boolean;
} | null;

/**
 * How long a reply's final save keeps trying through a database failover
 * (v0.11 design, section 3). The reply itself streams through Redis and is
 * unaffected; only its save needs the database. Meanwhile the run keeps
 * heartbeating in Redis, so no other replica recovers it as interrupted. If
 * the database is still unreachable after this, the save fails as before and
 * the claim is recovered as interrupted from the captured stream once the
 * database is back.
 */
export const finalSaveRetry: RetryOptions = { budgetMs: 30_000, initialDelayMs: 250 };

/** A continued reply adds this run's figures to the ones it already has. */
const added = (
  column:
    | typeof schema.message.tokensIn
    | typeof schema.message.tokensOut
    | typeof schema.message.durationMs,
  value: number,
) => sql<number>`coalesce(${column}, 0) + ${value}`;

function onRetry(runId: string, step: string) {
  return ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: unknown }) =>
    logger.warn(
      {
        runId,
        step,
        attempt,
        delayMs,
        err: error instanceof Error ? error.message : String(error),
      },
      'Database connection lost while saving a reply; retrying',
    );
}

/**
 * Saves a finished (or stopped, or failed) reply and settles its usage.
 *
 * Each database step is retried on a lost connection. Repeating them is safe:
 * the message update writes absolute values, except a continued reply's
 * token and duration totals, which are added; a retry of those applies only
 * while the reply is still `streaming`, so an attempt whose commit was lost
 * with its connection is not counted twice. Touching the thread and settling
 * usage are idempotent.
 */
export async function persistAssistant(
  { thread, user, continuation }: PreparedTurn,
  { assistantMessage, startedAt, reservation, runIdentity }: AcquiredRun,
  responseMessage: UIMessage,
  status: Exclude<ChatRunStatus, 'active'>,
  getUsage: () => Promise<ReplyUsage>,
  /** Stopped by this replica shutting down, not by the person. */
  interrupted = false,
) {
  const usage = await getUsage();
  const tokensIn = usage?.inputTokens ?? null;
  const tokensOut = usage?.outputTokens ?? null;
  const durationMs = Date.now() - startedAt;
  let persistenceFailure: { error: unknown } | undefined;
  try {
    await retryOnConnectionError(
      (attempt) =>
        db
          .update(schema.message)
          .set({
            parts: responseMessage.parts as unknown as Record<string, unknown>[],
            status,
            errorMessage:
              status === 'error'
                ? 'The model failed to generate a response'
                : interrupted
                  ? INTERRUPTED_REPLY_MESSAGE
                  : null,
            ...(continuation
              ? {
                  ...(tokensIn != null && { tokensIn: added(schema.message.tokensIn, tokensIn) }),
                  ...(tokensOut != null && {
                    tokensOut: added(schema.message.tokensOut, tokensOut),
                  }),
                  durationMs: added(schema.message.durationMs, durationMs),
                }
              : { tokensIn, tokensOut, durationMs }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.message.id, assistantMessage.id),
              eq(schema.message.threadId, thread.id),
              eq(schema.message.userId, user.id),
              ...(continuation && attempt > 1 ? [eq(schema.message.status, 'streaming')] : []),
            ),
          ),
      { ...finalSaveRetry, onRetry: onRetry(runIdentity.runId, 'message') },
    );

    await retryOnConnectionError(() => touchThread(thread.id), {
      ...finalSaveRetry,
      onRetry: onRetry(runIdentity.runId, 'thread'),
    });
  } catch (error) {
    persistenceFailure = { error };
  }
  // A finished reply's HTML, SVG and Mermaid blocks become artifacts. Best
  // effort and idempotent: a failure leaves them as ordinary code blocks.
  if (!persistenceFailure && status === 'complete') {
    try {
      await saveDetectedArtifacts({
        userId: user.id,
        role: user.role,
        threadId: thread.id,
        messageId: assistantMessage.id,
        parts: responseMessage.parts,
      });
    } catch (error) {
      logger.warn({ error, threadId: thread.id }, 'Saving detected artifacts failed');
    }
  }
  // Attempt both operations, but never replace the initiating persistence error
  // with a secondary settlement error. Report the latter separately.
  try {
    // After a save that already spent the retry budget, one attempt.
    await (persistenceFailure
      ? settleUsage(reservation, usage ?? null)
      : retryOnConnectionError(() => settleUsage(reservation, usage ?? null), {
          ...finalSaveRetry,
          onRetry: onRetry(runIdentity.runId, 'usage'),
        }));
  } catch (error) {
    logger.error(
      { error, threadId: thread.id, reservationId: reservation?.id },
      'Failed to settle chat usage',
    );
    if (!persistenceFailure) throw error;
  }
  if (persistenceFailure) throw persistenceFailure.error;
}
