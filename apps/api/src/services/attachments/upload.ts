import { randomUUID } from 'node:crypto';
import { and, eq, isNull, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';
import { buildStorageKey, getStorageDriver } from '../storage/index.js';
import { assertStorageAllowanceForUsage, getStorageLimits } from '../storage/quota.js';
import { attachmentTotals, lockStorageUsage } from '../storage/usage.js';
import { extractText } from './extract.js';
import { validateUpload } from './validate.js';

export interface UploadResult {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

/** Delete only an unfinished reservation; the trigger durably queues its object. */
async function releaseUpload(id: string, userId: string): Promise<void> {
  // Both object queueing and counter release are database delete triggers.
  // A completion commit may have succeeded despite a lost reply: preserve it.
  await db
    .delete(schema.attachment)
    .where(
      and(
        eq(schema.attachment.id, id),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, true),
      ),
    );
}

/** Reserve in PostgreSQL first, do I/O outside transactions, then publish metadata. */
export async function uploadAttachment(params: {
  userId: string;
  role: UserRole;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
}): Promise<UploadResult> {
  const storage = await getSetting('storage');
  const file = await validateUpload({
    ...params,
    allowedMimeTypes: storage.allowedMimeTypes,
    maxFileBytes: storage.maxFileBytes,
  });
  const limits = await getStorageLimits(params.role);
  const organizationId = await getDefaultOrganizationId();
  const driver = await getStorageDriver();
  const id = randomUUID();
  const storageKey = buildStorageKey(params.userId, id, file.filename);
  const owner = { organizationId, userId: params.userId };

  try {
    const row = await db.transaction(async (tx) => {
      // Account deletion locks the parent before its cascading children. Match
      // that order before taking usage, including when the usage row exists.
      const [user] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, params.userId))
        .for('key share');
      if (!user) throw notFound('Storage owner no longer exists');
      await lockStorageUsage(tx, owner);
      // Authoritative rows prevent legacy counter drift from weakening enforcement.
      const totals = await attachmentTotals(tx, params.userId);
      assertStorageAllowanceForUsage(
        { ...totals, ...limits },
        {
          incomingBytes: file.bytes.byteLength,
          incomingFiles: 1,
        },
      );
      const [reserved] = await tx
        .insert(schema.attachment)
        .values({
          ...owner,
          id,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          storageKey,
          uploadPending: true,
        })
        .returning();
      if (!reserved) throw new Error('Failed to reserve upload');
      await tx
        .update(schema.storageUsage)
        .set({
          ...totals,
          liveBytes: totals.liveBytes + file.bytes.byteLength,
          liveFileCount: totals.liveFileCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.storageUsage.userId, params.userId));
      return reserved;
    });

    await driver.put(storageKey, file.bytes, file.mimeType);
    const extractedText = await extractText(file.mimeType, file.bytes);
    const [completed] = await db
      .update(schema.attachment)
      .set({ extractedText, uploadPending: false })
      .where(
        and(
          eq(schema.attachment.id, id),
          eq(schema.attachment.userId, params.userId),
          eq(schema.attachment.uploadPending, true),
          isNull(schema.attachment.deletedAt),
        ),
      )
      .returning({ id: schema.attachment.id });
    if (!completed) throw new Error('Upload reservation is no longer valid');

    return {
      id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
      url: `/api/attachments/${id}/content`,
      createdAt: row.createdAt.toISOString(),
    };
  } catch (error) {
    // A failed compensation retains the reservation. Never guess that a crashed
    // producer is dead, or delete a successfully committed upload after ambiguity.
    await releaseUpload(id, params.userId).catch((cleanupError: unknown) => {
      logger.error({ err: cleanupError, attachmentId: id }, 'Upload reservation cleanup failed');
    });
    throw error;
  }
}
