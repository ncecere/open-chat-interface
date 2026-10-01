import { and, desc, eq, isNull, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { assertRoleFeature } from '../role-features.js';
import { getSetting } from '../settings.js';
import { adjustStorageUsage } from '../storage/usage.js';

export { type UploadResult, uploadAttachment } from './upload.js';

export async function assertAttachmentUseAllowed(role: UserRole): Promise<void> {
  await assertRoleFeature(role, 'attachments');

  const features = await getSetting('features');
  if (!features.attachments) {
    throw validationFailed('File uploads are disabled on this instance');
  }
}

export async function getOwnedAttachment(id: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.id, id),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Attachment not found');
  return row;
}

export async function listAttachments(userId: string) {
  return db
    .select()
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.userId, userId),
        isNull(schema.attachment.deletedAt),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .orderBy(desc(schema.attachment.createdAt))
    .limit(500);
}

/**
 * Moves an attachment to the trash.
 *
 * The blob is not touched here. Hard deletion happens when the grace window
 * elapses, at which point the delete trigger enqueues the object for the
 * storage reaper, so there is exactly one path to object removal.
 */
export async function deleteAttachment(id: string, userId: string): Promise<void> {
  // Allocation can happen once between discovering its thread and locking the
  // attachment. Retry outside the transaction rather than reversing lock order.
  for (;;) {
    const retry = await db.transaction(async (tx) => {
      const [thread] = await tx
        .select({ id: schema.thread.id })
        .from(schema.thread)
        .innerJoin(schema.message, eq(schema.message.threadId, schema.thread.id))
        .innerJoin(schema.attachment, eq(schema.attachment.messageId, schema.message.id))
        .where(and(eq(schema.attachment.id, id), eq(schema.attachment.userId, userId)))
        .for('update', { of: schema.thread });
      const [row] = await tx
        .select()
        .from(schema.attachment)
        .where(
          and(
            eq(schema.attachment.id, id),
            eq(schema.attachment.userId, userId),
            eq(schema.attachment.uploadPending, false),
          ),
        )
        .for('update');
      if (!row) throw notFound('Attachment not found');
      if (row.deletedAt) return false;
      if (row.messageId && !thread) return true;

      if (row.messageId) {
        const [message] = await tx
          .select({ parts: schema.message.parts })
          .from(schema.message)
          .where(eq(schema.message.id, row.messageId));
        if (message) {
          const parts = message.parts.filter((part) => {
            if (part.type !== 'data-attachment') return true;
            const data = part.data;
            return (
              typeof data !== 'object' || data === null || (data as { id?: unknown }).id !== id
            );
          });
          await tx
            .update(schema.message)
            .set({ parts })
            .where(eq(schema.message.id, row.messageId));
        }
      }
      await tx
        .update(schema.attachment)
        .set({ deletedAt: new Date(), deletedReason: 'user' })
        .where(eq(schema.attachment.id, id));
      await adjustStorageUsage(tx, {
        organizationId: row.organizationId,
        userId,
        liveBytes: -row.sizeBytes,
        liveFiles: -1,
        pendingBytes: row.sizeBytes,
        pendingFiles: 1,
      });
      return false;
    });
    if (!retry) return;
  }
}
