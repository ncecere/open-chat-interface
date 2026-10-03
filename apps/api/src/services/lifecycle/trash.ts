import { and, eq, inArray, isNotNull, isNull, lte, schema, sql } from '@oci/db';
import { type TrashedThread, USER_ROLES } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { recordDeletions } from '../compliance/deletions.js';
import {
  HELD_PERMANENT_DELETION_MESSAGE,
  isOnLegalHold,
  notOnLegalHold,
} from '../compliance/holds.js';
import { assertStorageAllowanceForUsage, getStorageLimits } from '../storage/quota.js';
import {
  artifactBytes,
  attachmentTotals,
  lockStorageUsage,
  threadArtifactBytes,
} from '../storage/usage.js';
import { destroyAttachments, destroyThreads } from './destroy.js';
import { lockLifecycleOwner } from './owner-lock.js';
import { getRetentionSettings } from './settings.js';
import { type DeleteReason, trashLockedThread } from './trash-thread.js';

export type { DeleteReason } from './trash-thread.js';

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
  actorUserId?: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, userId))) throw notFound('Thread not found');
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
      .limit(1)
      .for('update');

    if (!thread) throw notFound('Thread not found');
    await trashLockedThread(tx, { ...thread, userId }, reason, new Date(), actorUserId);
  });
}

/** Returns a thread and its attachments to normal use. */
export async function restoreThread(threadId: string, userId: string): Promise<void> {
  const [owner] = await db
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!owner) throw notFound('Thread not found in trash');
  const role = USER_ROLES.find((candidate) => candidate === owner.role);
  if (!role) throw new Error('Invalid storage owner role');
  const limits = await getStorageLimits(role);
  await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, userId))) throw notFound('Thread not found in trash');
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
      .limit(1)
      .for('update');

    if (!thread) throw notFound('Thread not found in trash');

    await tx
      .update(schema.thread)
      .set({ deletedAt: null, deletedReason: null })
      .where(eq(schema.thread.id, threadId));

    // Restoring private history must not republish old URLs. Preserve existing
    // revocations and revoke any legacy links that deletion failed to withdraw.
    // Sharing again requires a new link.
    await tx
      .update(schema.shareLink)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareLink.threadId, threadId), isNull(schema.shareLink.revokedAt)));

    const attachments = await tx
      .select({ id: schema.attachment.id, sizeBytes: schema.attachment.sizeBytes })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .where(
        and(eq(schema.message.threadId, threadId), eq(schema.attachment.deletedReason, 'thread')),
      )
      .orderBy(schema.attachment.id)
      .for('update', { of: schema.attachment });

    await recordDeletions(tx, [
      {
        action: 'conversation.restore',
        actorUserId: userId,
        id: threadId,
        ownerUserId: userId,
        reason: 'user',
        details: { attachments: attachments.length },
      },
    ]);

    // The conversation's artifacts count towards storage again once restored.
    const restoredArtifactBytes = await threadArtifactBytes(tx, threadId);
    if (attachments.length > 0 || restoredArtifactBytes > 0) {
      await lockStorageUsage(tx, { organizationId: thread.organizationId, userId });
      const totals = await attachmentTotals(tx, userId);
      // Already includes this conversation's artifacts: it is out of the trash above.
      const artifacts = await artifactBytes(tx, userId);
      const bytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
      assertStorageAllowanceForUsage(
        { ...totals, liveBytes: totals.liveBytes + artifacts - restoredArtifactBytes, ...limits },
        {
          incomingBytes: bytes + restoredArtifactBytes,
          incomingFiles: attachments.length,
          checkFileSize: false,
        },
      );
    }
    if (attachments.length > 0) {
      const totals = await attachmentTotals(tx, userId);
      await tx
        .update(schema.attachment)
        .set({ deletedAt: null, deletedReason: null })
        .where(
          inArray(
            schema.attachment.id,
            attachments.map((attachment) => attachment.id),
          ),
        );

      const bytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
      await tx
        .update(schema.storageUsage)
        .set({
          liveBytes: totals.liveBytes + bytes,
          liveFileCount: totals.liveFileCount + attachments.length,
          pendingBytes: Math.max(0, totals.pendingBytes - bytes),
          pendingFileCount: Math.max(0, totals.pendingFileCount - attachments.length),
          updatedAt: new Date(),
        })
        .where(eq(schema.storageUsage.userId, userId));
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
      // Qualified by hand: in a single-table select Drizzle drops column
      // qualifiers, so `id` here would resolve to message.id and count nothing.
      messageCount: sql<number>`(select count(*) from "message" as trashed_message where trashed_message.thread_id = "thread"."id")::int`,
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
  // Moving to the trash still works under a legal hold; destroying does not.
  if (await isOnLegalHold(userId)) throw conflict(HELD_PERMANENT_DELETION_MESSAGE);
  const deleted = await destroyThreads(
    and(
      eq(schema.thread.id, threadId),
      eq(schema.thread.userId, userId),
      isNotNull(schema.thread.deletedAt),
      // A hold placed since the check above still wins.
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'user', actorUserId: userId },
  );

  if (deleted.length === 0) throw notFound('Thread not found in trash');
}

/** Destroys everything currently in a user's trash. */
export async function emptyTrash(userId: string): Promise<number> {
  if (await isOnLegalHold(userId)) throw conflict(HELD_PERMANENT_DELETION_MESSAGE);
  const deleted = await destroyThreads(
    and(
      eq(schema.thread.userId, userId),
      isNotNull(schema.thread.deletedAt),
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'user', actorUserId: userId, all: true },
  );

  return deleted.length;
}

/**
 * Hard-deletes trash past the grace window.
 *
 * Attachment blobs are removed by the delete trigger, which enqueues them for
 * the storage reaper, so nothing here needs to touch object storage directly.
 * The trash of people on legal hold is kept until the hold is lifted. Each
 * conversation and file deleted is recorded as a deletion event with no actor
 * (reason `trash_expiry`).
 */
export async function purgeExpiredTrash(now: Date = new Date()): Promise<number> {
  const { trashRetentionDays } = await getRetentionSettings();
  const cutoff = new Date(now.getTime() - trashRetentionDays * 24 * 60 * 60 * 1000);

  const threads = await destroyThreads(
    and(
      isNotNull(schema.thread.deletedAt),
      lte(schema.thread.deletedAt, cutoff),
      notOnLegalHold(schema.thread.userId),
    ),
    { reason: 'trash_expiry', actorUserId: null, skipLocked: true, all: true },
  );

  // Attachments soft-deleted on their own, rather than with a thread.
  const attachments = await destroyAttachments(
    and(
      isNotNull(schema.attachment.deletedAt),
      lte(schema.attachment.deletedAt, cutoff),
      notOnLegalHold(schema.attachment.userId),
    ),
    { reason: 'trash_expiry', actorUserId: null, skipLocked: true, all: true },
  );

  return threads.length + attachments.length;
}
