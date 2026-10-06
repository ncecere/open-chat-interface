import { and, eq, isNull, schema } from '@oci/db';
import { ERROR_CODES } from '@oci/shared';
import { db } from '../../db/index.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { nextPosition } from '../threads.js';
import { denyOpenApprovals } from './pending-approvals.js';
import { claimProducerQuietInMs, recoverStaleClaim, runLiveness } from './run-recovery.js';
import type { TurnContext } from './turn-context.js';
import { retryTurnStep } from './turn-patience.js';

export type ChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recheck expiry after acquiring the row lock, not before a possible wait. */
export async function lockChatThread(tx: ChatTransaction, threadId: string, userId: string) {
  // Inserts later check the user FK. Lock the parent first so account deletion
  // cannot own that parent while waiting on our thread/file locks.
  const [owner] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for('key share');
  if (!owner) throw notFound('Thread not found or expired');
  const [thread] = await tx
    .select()
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        isNull(schema.thread.deletedAt),
      ),
    )
    .for('update');
  if (
    !thread ||
    (thread.temporary && (!thread.expiresAt || thread.expiresAt.getTime() <= Date.now()))
  ) {
    throw notFound('Thread not found or expired');
  }
  return thread;
}

const GENERATING_MESSAGE = 'A response is already being generated for this thread';

/** The thread's open claim belongs to a producer that may be gone. */
class ActiveClaim extends Error {
  constructor(
    readonly messageId: string,
    /** When the producer last refreshed the claim. */
    readonly updatedAt: Date,
  ) {
    super(GENERATING_MESSAGE);
  }
}

/**
 * The refusal while a claim is open but not yet recoverable. A live producer
 * refreshes the claim every second heartbeat; one silent for longer than that
 * (and a margin) is almost certainly a server that stopped, whose reply is
 * recovered once it has been silent for `staleMs`. Saying "already being
 * generated" then is wrong, and for up to 20 s after a crash (#121).
 *
 * Recovery also waits until the producer is silent in Redis (its heartbeat,
 * refreshed twice as often as the claim, and its last event), so the seconds
 * given are the later of the two (`redisQuietInMs`); counting from the claim
 * alone ran out up to ten seconds early and then repeated "1 second" (#163).
 */
export function claimRefusal(updatedAt: Date, now = Date.now(), redisQuietInMs = 0) {
  const silentMs = now - updatedAt.getTime();
  const interruptedAfterMs = 2 * runLiveness.heartbeatMs + 2_000;
  if (silentMs <= interruptedAfterMs) return conflict(GENERATING_MESSAGE);
  const waitMs = Math.max(runLiveness.staleMs - silentMs, redisQuietInMs);
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return new AppError(
    ERROR_CODES.CONFLICT,
    `The previous reply in this conversation was interrupted and is being recovered. Send your message again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    409,
    undefined,
    seconds,
  );
}

/**
 * The empty streaming assistant is the durable claim, in every Redis mode.
 * A claim whose producer has stopped heartbeating (run-recovery.ts) is saved
 * as interrupted and admission tried once more; any other open claim refuses
 * the turn, since a slow producer is still writing it.
 */
export async function claimThread(context: TurnContext, runId: string): Promise<{ id: string }> {
  try {
    // A new message waits out a lost connection here too (#326).
    return await retryTurnStep(context.admission?.deadline, 'claim', () =>
      claimOnce(context, runId),
    );
  } catch (error) {
    if (!(error instanceof ActiveClaim)) throw error;
    const recovered = await recoverStaleClaim({
      messageId: error.messageId,
      threadId: context.thread.id,
      userId: context.user.id,
    }).catch(() => false);
    if (!recovered)
      throw claimRefusal(
        error.updatedAt,
        Date.now(),
        await claimProducerQuietInMs({
          messageId: error.messageId,
          threadId: context.thread.id,
        }).catch(() => 0),
      );
    try {
      return await claimOnce(context, runId);
    } catch (retry) {
      throw retry instanceof ActiveClaim ? claimRefusal(retry.updatedAt) : retry;
    }
  }
}

async function claimOnce(context: TurnContext, runId: string): Promise<{ id: string }> {
  const { thread, user, resolved, input } = context;
  const { claim, auditDenials } = await db.transaction(async (tx) => {
    await lockChatThread(tx, thread.id, user.id);
    const [active] = await tx
      .select({ id: schema.message.id, updatedAt: schema.message.updatedAt })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.threadId, thread.id),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
        ),
      )
      .limit(1);
    // Our own claim: an earlier attempt committed just as its connection was
    // lost (#326). It stands, and is not made twice; only the audit events of
    // the approvals it denied were lost with that attempt's answer.
    if (active?.id === runId) return { claim: { id: runId }, auditDenials: async () => {} };
    if (active) throw new ActiveClaim(active.id, active.updatedAt);
    // Sending a message instead of answering denies open approvals, so the
    // model never sees a dangling call.
    const auditDenials = await denyOpenApprovals(tx, thread.id, user.id);
    const [claim] = await tx
      .insert(schema.message)
      .values({
        id: runId,
        threadId: thread.id,
        userId: user.id,
        role: 'assistant',
        parts: [],
        position: await nextPosition(thread.id, tx),
        modelSlug: resolved.slug,
        effort: input.effort ?? null,
        webSearchUsed: input.webSearch,
        status: 'streaming',
      })
      .returning({ id: schema.message.id });
    if (!claim) throw new Error('Failed to claim thread');
    return { claim, auditDenials };
  });
  await auditDenials();
  return claim;
}
