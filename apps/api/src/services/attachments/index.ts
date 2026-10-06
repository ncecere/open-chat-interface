import { and, desc, eq, isNull, lte, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { recordDeletions } from '../compliance/deletions.js';
import { notOnLegalHold } from '../compliance/holds.js';
import { destroyAttachments } from '../lifecycle/destroy.js';
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

/**
 * Settings → Attachments: chat files (message attachments and staged
 * uploads) and, since v0.9.1, project files with the project they belong to,
 * so the list accounts for what the storage meter counts. Newest first.
 */
export async function listAttachments(userId: string) {
  return db
    .select({
      id: schema.attachment.id,
      filename: schema.attachment.filename,
      mimeType: schema.attachment.mimeType,
      sizeBytes: schema.attachment.sizeBytes,
      createdAt: schema.attachment.createdAt,
      messageId: schema.attachment.messageId,
      projectId: schema.attachment.projectId,
      projectName: schema.project.name,
    })
    .from(schema.attachment)
    .leftJoin(schema.project, eq(schema.project.id, schema.attachment.projectId))
    .where(
      and(
        eq(schema.attachment.userId, userId),
        isNull(schema.attachment.deletedAt),
        eq(schema.attachment.uploadPending, false),
      ),
    )
    .orderBy(desc(schema.attachment.createdAt), desc(schema.attachment.id))
    .limit(500);
}

/**
 * Moves an attachment to the trash.
 *
 * The blob is not touched here. Hard deletion happens when the grace window
 * elapses, at which point the delete trigger enqueues the object for the
 * storage reaper, so there is exactly one path to object removal.
 *
 * Project files are not found here: they are removed through their project
 * (`DELETE /projects/:id/files/:fileId`), which deletes them outright.
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
            isNull(schema.attachment.projectId),
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
      await trashRow(tx, row, thread?.id ?? null);
      return false;
    });
    if (!retry) return;
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Moves one locked chat file to the trash, by its owner. */
async function trashRow(
  tx: Transaction,
  row: typeof schema.attachment.$inferSelect,
  threadId: string | null,
) {
  await tx
    .update(schema.attachment)
    .set({ deletedAt: new Date(), deletedReason: 'user' })
    .where(eq(schema.attachment.id, row.id));
  await recordDeletions(tx, [
    {
      action: 'attachment.trash',
      actorUserId: row.userId,
      id: row.id,
      ownerUserId: row.userId,
      reason: 'user',
      details: { threadId, messageId: row.messageId, sizeBytes: row.sizeBytes },
    },
  ]);
  await adjustStorageUsage(tx, {
    organizationId: row.organizationId,
    userId: row.userId,
    liveBytes: -row.sizeBytes,
    liveFiles: -1,
    pendingBytes: row.sizeBytes,
    pendingFiles: 1,
  });
}

/** Never-sent chat uploads: not part of a message or a project, not in the trash. */
function unsent() {
  return and(
    isNull(schema.attachment.messageId),
    isNull(schema.attachment.projectId),
    isNull(schema.attachment.deletedAt),
  );
}

/**
 * Moves an upload that was never sent to the trash, as its × in the composer
 * does (#297). The composer discards its uploads when it is left without
 * sending them (New Chat, another conversation); they stayed stored, counted
 * and listed as if sent. A file sent meanwhile (a send accepted after all:
 * sending locks the file as this does) is kept. Returns whether it went.
 */
export async function discardUnsentAttachment(id: string, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.id, id),
          eq(schema.attachment.userId, userId),
          eq(schema.attachment.uploadPending, false),
          unsent(),
        ),
      )
      .for('update');
    if (!row) return false;
    await trashRow(tx, row, null);
    return true;
  });
}

/** How long an upload may stay unsent before the cleanup job deletes it (#297). */
export const UNSENT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes uploads never sent with a message for a day (#297): left when a
 * page closed or an upload finished after its composer was gone, so the
 * composer could not discard them, and unfinished uploads a crash left
 * behind. Nothing refers to them, so they skip the trash; the delete trigger
 * releases their storage and queues their objects. Kept under legal hold.
 */
export async function purgeUnsentUploads(now = new Date()): Promise<number> {
  const removed = await destroyAttachments(
    and(
      unsent(),
      lte(schema.attachment.createdAt, new Date(now.getTime() - UNSENT_UPLOAD_TTL_MS)),
      notOnLegalHold(schema.attachment.userId),
    ),
    { reason: 'unused_expiry', actorUserId: null, skipLocked: true, all: true },
  );
  return removed.length;
}
