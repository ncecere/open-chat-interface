import { and, desc, eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getSetting } from '../settings.js';
import { buildStorageKey, getStorageDriver } from '../storage/index.js';
import { extractText } from './extract.js';
import { isImage, validateUpload } from './validate.js';

export async function assertAttachmentUseAllowed(role: UserRole): Promise<void> {
  if (role === 'restricted') {
    throw forbidden('Your role does not allow file uploads');
  }

  const features = await getSetting('features');
  if (!features.attachments) {
    throw validationFailed('File uploads are disabled on this instance');
  }
}

export interface UploadResult {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

export async function uploadAttachment(params: {
  userId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
}): Promise<UploadResult> {
  const storage = await getSetting('storage');

  const file = await validateUpload({
    filename: params.filename,
    declaredMimeType: params.declaredMimeType,
    bytes: params.bytes,
    allowedMimeTypes: storage.allowedMimeTypes,
    maxFileBytes: storage.maxFileBytes,
  });

  const organizationId = await getDefaultOrganizationId();

  const [row] = await db
    .insert(schema.attachment)
    .values({
      organizationId,
      userId: params.userId,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
      // Replaced below once the ID is known.
      storageKey: 'pending',
    })
    .returning({ id: schema.attachment.id, createdAt: schema.attachment.createdAt });

  if (!row) throw new Error('Failed to create attachment record');

  const storageKey = buildStorageKey(params.userId, row.id, file.filename);
  const driver = await getStorageDriver();
  let objectStored = false;

  try {
    await driver.put(storageKey, file.bytes, file.mimeType);
    objectStored = true;

    const extractedText = await extractText(file.mimeType, file.bytes);
    await db
      .update(schema.attachment)
      .set({ storageKey, extractedText })
      .where(eq(schema.attachment.id, row.id));
  } catch (error) {
    // Compensate best-effort so failed uploads do not leave pending rows or
    // unreferenced blobs behind.
    if (objectStored) await driver.delete(storageKey).catch(() => undefined);
    await db
      .delete(schema.attachment)
      .where(eq(schema.attachment.id, row.id))
      .catch(() => undefined);
    throw error;
  }

  return {
    id: row.id,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.bytes.byteLength,
    url: `/api/attachments/${row.id}/content`,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOwnedAttachment(id: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.attachment)
    .where(and(eq(schema.attachment.id, id), eq(schema.attachment.userId, userId)))
    .limit(1);

  if (!row) throw notFound('Attachment not found');
  return row;
}

export async function listAttachments(userId: string) {
  return db
    .select()
    .from(schema.attachment)
    .where(eq(schema.attachment.userId, userId))
    .orderBy(desc(schema.attachment.createdAt))
    .limit(500);
}

export async function deleteAttachment(id: string, userId: string): Promise<void> {
  const row = await getOwnedAttachment(id, userId);

  // Keep message display metadata and the attachment row consistent. Storage
  // cleanup follows the transaction; a failed object deletion can be retried
  // without leaving a broken card in the conversation.
  await db.transaction(async (tx) => {
    if (row.messageId) {
      const [message] = await tx
        .select({ parts: schema.message.parts })
        .from(schema.message)
        .where(eq(schema.message.id, row.messageId))
        .limit(1);

      if (message) {
        const parts = message.parts.filter((part) => {
          if (part.type !== 'data-attachment') return true;
          const data = part.data;
          return (
            typeof data !== 'object' || data === null || (data as { id?: unknown }).id !== row.id
          );
        });

        await tx.update(schema.message).set({ parts }).where(eq(schema.message.id, row.messageId));
      }
    }

    await tx.delete(schema.attachment).where(eq(schema.attachment.id, row.id));
  });

  const driver = await getStorageDriver();
  await driver.delete(row.storageKey).catch((error) => {
    logger.warn(
      { error, attachmentId: row.id, storageKey: row.storageKey },
      'Orphaned attachment blob',
    );
  });
}

/**
 * Loads attachments for a message, enforcing ownership and the per-message
 * count limit before they are handed to a model.
 */
export async function loadAttachmentsForMessage(
  attachmentIds: string[],
  userId: string,
  role: UserRole,
) {
  if (attachmentIds.length === 0) return [];

  await assertAttachmentUseAllowed(role);
  const uniqueIds = [...new Set(attachmentIds)];
  const storage = await getSetting('storage');
  if (uniqueIds.length > storage.maxFilesPerMessage) {
    throw validationFailed(`At most ${storage.maxFilesPerMessage} files can be sent per message`);
  }

  const rows = await Promise.all(uniqueIds.map((id) => getOwnedAttachment(id, userId)));
  if (rows.some((row) => row.messageId !== null)) {
    throw validationFailed('An attachment can only be sent once');
  }

  const driver = await getStorageDriver();

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      extractedText: row.extractedText,
      // Only images need their bytes; text is already extracted.
      bytes: isImage(row.mimeType) ? await driver.get(row.storageKey) : null,
    })),
  );
}
