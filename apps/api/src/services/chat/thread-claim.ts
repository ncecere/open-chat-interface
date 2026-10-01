import { and, eq, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { nextPosition } from '../threads.js';
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

/**
 * The empty streaming assistant is the durable claim, in every Redis mode.
 * No time-based takeover: a slow producer and a dead one are indistinguishable.
 * Uncertain/orphaned runs fail closed until an operator stops their producer.
 */
export async function claimThread(context: TurnContext, runId: string): Promise<{ id: string }> {
  const { thread, user, resolved, input } = context;
  return db.transaction(async (tx) => {
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
    if (active) throw conflict('A response is already being generated for this thread');
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
    return claim;
  });
}
