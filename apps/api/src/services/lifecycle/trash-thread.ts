import { and, eq, inArray, isNull, schema } from '@oci/db';
import type { db } from '../../db/index.js';
import { recordDeletions } from '../compliance/deletions.js';
import { adjustStorageUsage } from '../storage/quota.js';

export type DeleteReason = 'user' | 'retention' | 'admin';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LockedThread = Pick<typeof schema.thread.$inferSelect, 'id' | 'userId' | 'organizationId'>;

/**
 * Shared deletion bookkeeping for user/admin deletion and retention. The caller
 * must lock the user parent first (KEY SHARE), then hold an UPDATE lock on the
 * live thread in this transaction. Parent-first avoids account-cascade cycles;
 * the thread lock keeps
 * concurrent deletion/restoration from adjusting storage twice and serializes
 * deletion with share creation/public reads, which take a SHARE lock.
 */
export async function trashLockedThread(
  tx: Transaction,
  thread: LockedThread,
  reason: DeleteReason,
  now: Date,
  /** Who moved it; defaults to the owner for `user` and nobody (a job) otherwise. */
  actorUserId: string | null = reason === 'user' ? thread.userId : null,
): Promise<void> {
  // Children stay valid conversations; only the stale navigation link goes.
  await tx
    .update(schema.thread)
    .set({ parentThreadId: null })
    .where(
      and(eq(schema.thread.parentThreadId, thread.id), eq(schema.thread.userId, thread.userId)),
    );

  await tx
    .update(schema.thread)
    .set({ deletedAt: now, deletedReason: reason, pinned: false })
    .where(eq(schema.thread.id, thread.id));

  // A queued summary is dropped; one being made is discarded when it ends.
  await tx
    .delete(schema.conversationCompactionJob)
    .where(eq(schema.conversationCompactionJob.threadId, thread.id));

  // Never overwrite an explicit revocation's timestamp/provenance.
  await tx
    .update(schema.shareLink)
    .set({ revokedAt: now })
    .where(and(eq(schema.shareLink.threadId, thread.id), isNull(schema.shareLink.revokedAt)));

  const attachments = await tx
    .select({ id: schema.attachment.id, sizeBytes: schema.attachment.sizeBytes })
    .from(schema.attachment)
    .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
    .where(and(eq(schema.message.threadId, thread.id), isNull(schema.attachment.deletedAt)))
    .orderBy(schema.attachment.id)
    .for('update', { of: schema.attachment });

  await recordDeletions(tx, [
    {
      action: 'conversation.trash',
      actorUserId,
      id: thread.id,
      ownerUserId: thread.userId,
      reason,
      details: { attachments: attachments.length },
    },
  ]);

  if (attachments.length === 0) return;

  await tx
    .update(schema.attachment)
    .set({ deletedAt: now, deletedReason: 'thread' })
    .where(
      inArray(
        schema.attachment.id,
        attachments.map((attachment) => attachment.id),
      ),
    );

  const bytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
  await adjustStorageUsage(tx, {
    organizationId: thread.organizationId,
    userId: thread.userId,
    liveBytes: -bytes,
    liveFiles: -attachments.length,
    pendingBytes: bytes,
    pendingFiles: attachments.length,
  });
}
