import { and, eq, isNotNull, isNull, lte, schema, sql } from '@oci/db';
import type { TrashedThread } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { adjustStorageUsage } from '../storage/quota.js';
import { getRetentionSettings } from './settings.js';

export type DeleteReason = 'user' | 'retention' | 'admin';

/**
 * Moves a thread to the trash.
 *
 * Share links are revoked immediately: someone holding the URL must not keep
 * reading a conversation its owner just deleted. Attachments follow the thread
 * rather than getting their own trash entry, so restoring the thread brings
 * its files back with it.
 *
 * Soft-deleted bytes stop counting against the owner's storage allowance at
 * once. Waiting out the grace window would mean a user who cleans up to make
 * room gets nothing back, which is the opposite of what they asked for.
 */
export async function softDeleteThread(
  threadId: string,
  userId: string,
  reason: DeleteReason = 'user',
): Promise<void> {
  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: schema.thread.id, organizationId: schema.thread.organizationId })
      .from(schema.thread)
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          isNull(schema.thread.deletedAt),
        ),
      )
      .limit(1);

    if (!thread) throw notFound('Thread not found');
    const now = new Date();

    // Children stay valid conversations; only the stale navigation link goes.
    await tx
      .update(schema.thread)
      .set({ parentThreadId: null })
      .where(and(eq(schema.thread.parentThreadId, threadId), eq(schema.thread.userId, userId)));

    await tx
      .update(schema.thread)
      .set({ deletedAt: now, deletedReason: reason, pinned: false })
      .where(eq(schema.thread.id, threadId));

    await tx
      .update(schema.shareLink)
      .set({ revokedAt: now })
      .where(and(eq(schema.shareLink.threadId, threadId), isNull(schema.shareLink.revokedAt)));

    const attachments = await tx
      .select({ id: schema.attachment.id, sizeBytes: schema.attachment.sizeBytes })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .where(and(eq(schema.message.threadId, threadId), isNull(schema.attachment.deletedAt)));

    if (attachments.length > 0) {
      await tx
        .update(schema.attachment)
        .set({ deletedAt: now, deletedReason: 'thread' })
        .where(
          sql`${schema.attachment.id} = any(${attachments.map((attachment) => attachment.id)})`,
        );

      const bytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
      await adjustStorageUsage(tx, {
        organizationId: thread.organizationId,
        userId,
        liveBytes: -bytes,
        liveFiles: -attachments.length,
        pendingBytes: bytes,
        pendingFiles: attachments.length,
      });
    }
  });
}

/** Returns a thread and its attachments to normal use. */
export async function restoreThread(threadId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: schema.thread.id, organizationId: schema.thread.organizationId })
      .from(schema.thread)
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          isNotNull(schema.thread.deletedAt),
        ),
      )
      .limit(1);

    if (!thread) throw notFound('Thread not found in trash');

    await tx
      .update(schema.thread)
      .set({ deletedAt: null, deletedReason: null })
      .where(eq(schema.thread.id, threadId));

    // Deleting revoked the links because the owner meant to withdraw them;
    // restoring is an undo, so the same links come back.
    await tx
      .update(schema.shareLink)
      .set({ revokedAt: null })
      .where(and(eq(schema.shareLink.threadId, threadId), isNotNull(schema.shareLink.revokedAt)));

    const attachments = await tx
      .select({ id: schema.attachment.id, sizeBytes: schema.attachment.sizeBytes })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .where(
        and(eq(schema.message.threadId, threadId), eq(schema.attachment.deletedReason, 'thread')),
      );

    if (attachments.length > 0) {
      await tx
        .update(schema.attachment)
        .set({ deletedAt: null, deletedReason: null })
        .where(
          sql`${schema.attachment.id} = any(${attachments.map((attachment) => attachment.id)})`,
        );

      const bytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
      await adjustStorageUsage(tx, {
        organizationId: thread.organizationId,
        userId,
        liveBytes: bytes,
        liveFiles: attachments.length,
        pendingBytes: -bytes,
        pendingFiles: -attachments.length,
      });
    }
  });
}

export async function listTrashedThreads(userId: string): Promise<TrashedThread[]> {
  const { trashRetentionDays } = await getRetentionSettings();
  const graceMs = trashRetentionDays * 24 * 60 * 60 * 1000;

  const rows = await db
    .select({
      id: schema.thread.id,
      title: schema.thread.title,
      deletedAt: schema.thread.deletedAt,
      deletedReason: schema.thread.deletedReason,
      messageCount: sql<number>`(select count(*) from ${schema.message} where ${schema.message.threadId} = ${schema.thread.id})::int`,
    })
    .from(schema.thread)
    .where(and(eq(schema.thread.userId, userId), isNotNull(schema.thread.deletedAt)))
    .orderBy(sql`${schema.thread.deletedAt} desc`)
    .limit(200);

  return rows.flatMap((row) =>
    row.deletedAt
      ? [
          {
            id: row.id,
            title: row.title,
            messageCount: Number(row.messageCount),
            deletedAt: row.deletedAt.toISOString(),
            deletedReason: row.deletedReason as TrashedThread['deletedReason'],
            purgeAt: new Date(row.deletedAt.getTime() + graceMs).toISOString(),
          },
        ]
      : [],
  );
}

/**
 * Destroys one trashed thread immediately. Expected in any trash UI, and the
 * only way to make something genuinely gone before the window elapses.
 */
export async function purgeTrashedThread(threadId: string, userId: string): Promise<void> {
  const deleted = await db
    .delete(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, userId),
        isNotNull(schema.thread.deletedAt),
      ),
    )
    .returning({ id: schema.thread.id });

  if (deleted.length === 0) throw notFound('Thread not found in trash');
}

/** Destroys everything currently in a user's trash. */
export async function emptyTrash(userId: string): Promise<number> {
  const deleted = await db
    .delete(schema.thread)
    .where(and(eq(schema.thread.userId, userId), isNotNull(schema.thread.deletedAt)))
    .returning({ id: schema.thread.id });

  return deleted.length;
}

/**
 * Hard-deletes trash past the grace window.
 *
 * Attachment blobs are removed by the delete trigger, which enqueues them for
 * the storage reaper, so nothing here needs to touch object storage directly.
 */
export async function purgeExpiredTrash(now: Date = new Date()): Promise<number> {
  const { trashRetentionDays } = await getRetentionSettings();
  const cutoff = new Date(now.getTime() - trashRetentionDays * 24 * 60 * 60 * 1000);

  const threads = await db
    .delete(schema.thread)
    .where(and(isNotNull(schema.thread.deletedAt), lte(schema.thread.deletedAt, cutoff)))
    .returning({ id: schema.thread.id });

  // Attachments soft-deleted on their own, rather than with a thread.
  const attachments = await db
    .delete(schema.attachment)
    .where(and(isNotNull(schema.attachment.deletedAt), lte(schema.attachment.deletedAt, cutoff)))
    .returning({ id: schema.attachment.id });

  return threads.length + attachments.length;
}
