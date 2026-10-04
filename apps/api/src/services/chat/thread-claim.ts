import { and, eq, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { nextPosition } from '../threads.js';
import { denyOpenApprovals } from './pending-approvals.js';
import { recoverStaleClaim } from './run-recovery.js';
import type { TurnContext } from './turn-context.js';

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

/** The thread's open claim belongs to a producer that may be gone. */
class ActiveClaim extends Error {
  constructor(readonly messageId: string) {
    super('A response is already being generated for this thread');
  }
}

/**
 * The empty streaming assistant is the durable claim, in every Redis mode.
 * A claim whose producer has stopped heartbeating (run-recovery.ts) is saved
 * as interrupted and admission tried once more; any other open claim refuses
 * the turn, since a slow producer is still writing it.
 */
export async function claimThread(context: TurnContext, runId: string): Promise<{ id: string }> {
  try {
    return await claimOnce(context, runId);
  } catch (error) {
    if (!(error instanceof ActiveClaim)) throw error;
    const recovered = await recoverStaleClaim({
      messageId: error.messageId,
      threadId: context.thread.id,
      userId: context.user.id,
    }).catch(() => false);
    if (!recovered) throw conflict(error.message);
    try {
      return await claimOnce(context, runId);
    } catch (retry) {
      throw retry instanceof ActiveClaim ? conflict(retry.message) : retry;
    }
  }
}

async function claimOnce(context: TurnContext, runId: string): Promise<{ id: string }> {
  const { thread, user, resolved, input } = context;
  const { claim, auditDenials } = await db.transaction(async (tx) => {
    await lockChatThread(tx, thread.id, user.id);
    const [active] = await tx
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.threadId, thread.id),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
        ),
      )
      .limit(1);
    if (active) throw new ActiveClaim(active.id);
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
