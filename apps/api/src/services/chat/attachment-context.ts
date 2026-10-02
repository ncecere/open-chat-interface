import { and, asc, eq, gt, inArray, isNull, or, schema, sql } from '@oci/db';
import type { UserRole } from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { assertAttachmentUseAllowed } from '../attachments/index.js';
import { isImage } from '../attachments/validate.js';
import { getSetting } from '../settings.js';
import { getStorageDriver } from '../storage/index.js';
import {
  type ContextCost,
  IMAGE_INPUT_UNITS,
  MAX_CONTEXT_FILES,
  MAX_IMAGE_BYTES,
  MAX_INPUT_UNITS,
} from './context-budget.js';

export type ModelAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  extractedText: string | null;
  bytes: Buffer | null;
};
export type HistoricalAttachmentReference = { id: string; messageId: string };
export const UNAVAILABLE_ATTACHMENT_TEXT = 'A previously attached file is no longer available.';
export type StoredMessage = { id: string; role: string; parts: unknown };
export type AttachmentCandidate = {
  id: string;
  messageId: string | null;
  mimeType: string;
  sizeBytes: number;
  textBytes: number;
  filenameBytes: number;
  deletedAt: Date | null;
};
const candidateColumns = {
  id: schema.attachment.id,
  messageId: schema.attachment.messageId,
  mimeType: schema.attachment.mimeType,
  sizeBytes: schema.attachment.sizeBytes,
  textBytes: sql<number>`coalesce(octet_length(${schema.attachment.extractedText}), 0)`,
  filenameBytes: sql<number>`octet_length(${schema.attachment.filename})`,
  deletedAt: schema.attachment.deletedAt,
};

export function attachmentCost(file: AttachmentCandidate, supportsVision: boolean): ContextCost {
  const image = supportsVision && isImage(file.mimeType);
  return {
    units:
      file.filenameBytes +
      Buffer.byteLength(file.mimeType) +
      128 +
      (image ? IMAGE_INPUT_UNITS : file.textBytes),
    files: 1,
    imageBytes: image ? file.sizeBytes : 0,
  };
}

/** Inspect sizes before reading extracted text or opening a blob. */
export async function inspectIncomingAttachments(ids: string[], userId: string, role: UserRole) {
  if (!ids.length) return [];
  if (ids.length > MAX_CONTEXT_FILES)
    throw validationFailed(`At most ${MAX_CONTEXT_FILES} files fit in model context`);
  await assertAttachmentUseAllowed(role);
  const uniqueIds = [...new Set(ids)];
  const storage = await getSetting('storage');
  if (uniqueIds.length > storage.maxFilesPerMessage)
    throw validationFailed(`At most ${storage.maxFilesPerMessage} files can be sent per message`);
  const rows = await db
    .select(candidateColumns)
    .from(schema.attachment)
    .where(
      and(
        inArray(schema.attachment.id, uniqueIds),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        // A project file joins context through its project, never as a message upload.
        isNull(schema.attachment.projectId),
        sql`octet_length(${schema.attachment.mimeType}) <= 256`,
      ),
    );
  if (rows.length !== uniqueIds.length) throw notFound('Attachment not found');
  if (rows.some((row) => row.messageId !== null || row.deletedAt !== null))
    throw validationFailed('Attachments must be available and not already sent');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return uniqueIds.map((id) => byId.get(id)!);
}

/**
 * A project's ready files as context candidates, oldest first, without loading
 * payloads. Costed and selected by the caller like any other attachment, then
 * loaded through `materializeAttachments`.
 */
export async function inspectProjectFiles(
  projectId: string,
  userId: string,
): Promise<AttachmentCandidate[]> {
  return db
    .select(candidateColumns)
    .from(schema.attachment)
    .where(
      and(
        eq(schema.attachment.projectId, projectId),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
        sql`octet_length(${schema.attachment.mimeType}) <= 256`,
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))
    .limit(MAX_CONTEXT_FILES);
}

/** Called only after selection. Ready payloads are immutable in normal application writes. */
export async function materializeAttachments(
  candidates: AttachmentCandidate[],
  userId: string,
  role: UserRole,
  supportsVision: boolean,
) {
  if (!candidates.length) return new Map<string, ModelAttachment>();
  if (candidates.length > MAX_CONTEXT_FILES) throw validationFailed('Too many context files');
  await assertAttachmentUseAllowed(role);
  const unique = new Map(candidates.map((file) => [file.id, file]));
  const rows = await db
    .select()
    .from(schema.attachment)
    .where(
      and(
        inArray(schema.attachment.id, [...unique.keys()]),
        eq(schema.attachment.userId, userId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
        sql`octet_length(${schema.attachment.filename}) <= ${MAX_INPUT_UNITS}`,
        sql`coalesce(octet_length(${schema.attachment.extractedText}), 0) <= ${MAX_INPUT_UNITS}`,
        sql`octet_length(${schema.attachment.storageKey}) <= 1024`,
        sql`octet_length(${schema.attachment.mimeType}) <= 256`,
      ),
    );
  if (
    rows.length !== unique.size ||
    rows.some((row) => {
      const before = unique.get(row.id)!;
      return (
        row.messageId !== before.messageId ||
        row.mimeType !== before.mimeType ||
        row.sizeBytes !== before.sizeBytes ||
        Buffer.byteLength(row.filename) !== before.filenameBytes ||
        Buffer.byteLength(row.extractedText ?? '') !== before.textBytes
      );
    })
  )
    throw validationFailed('Attachment context changed while preparing the reply. Try again.');
  const driver =
    supportsVision && rows.some((file) => isImage(file.mimeType)) ? await getStorageDriver() : null;
  const loaded = new Map<string, ModelAttachment>();
  let imageBytes = 0;
  // Sequential reads avoid multiplying peak blob memory across concurrent files.
  for (const file of rows) {
    const bytes = driver && isImage(file.mimeType) ? await driver.get(file.storageKey) : null;
    if (bytes) {
      imageBytes += bytes.length;
      if (bytes.length !== file.sizeBytes || imageBytes > MAX_IMAGE_BYTES)
        throw validationFailed('Attachment bytes exceed the model input limit');
    }
    loaded.set(file.id, {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      extractedText: file.extractedText,
      bytes,
    });
  }
  return loaded;
}

/** Only server-stored data references are eligible; never follow stored/client URLs. */
export function attachmentIds(message: StoredMessage): string[] {
  if (message.role !== 'user' || !Array.isArray(message.parts)) return [];
  return [
    ...new Set(
      message.parts.flatMap((part) => {
        if (part?.type !== 'data-attachment' || typeof part.data?.id !== 'string') return [];
        return part.data.id ? [part.data.id] : [];
      }),
    ),
  ];
}

/** Shared by hydration and the post-lock check; caller joins the original message/thread. */
export function historicalAttachmentAvailable(userId: string) {
  return and(
    eq(schema.attachment.userId, userId),
    eq(schema.message.userId, userId),
    eq(schema.message.role, 'user'),
    eq(schema.thread.userId, userId),
    isNull(schema.thread.deletedAt),
    or(eq(schema.thread.temporary, false), gt(schema.thread.expiresAt, sql`clock_timestamp()`)),
    isNull(schema.attachment.deletedAt),
    eq(schema.attachment.uploadPending, false),
  );
}

/** Inspect original and copied references without loading file payloads. */
export async function inspectHistoricalAttachments(messages: StoredMessage[], userId: string) {
  const idsByMessage = new Map(messages.map((message) => [message.id, attachmentIds(message)]));
  const ids = [...new Set([...idsByMessage.values()].flat())];
  if (ids.length > MAX_CONTEXT_FILES) throw validationFailed('Too many historical context files');
  const byMessage = new Map<string, AttachmentCandidate[]>();
  const unavailable = new Set<string>();
  if (!ids.length) return { byMessage, unavailable };
  // A fork copies canonical server metadata, while allocation stays on the
  // original user turn. Require that original owner/thread to remain available.
  const rows = await db
    .select(candidateColumns)
    .from(schema.attachment)
    .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
    .innerJoin(schema.thread, eq(schema.thread.id, schema.message.threadId))
    .where(
      and(
        inArray(schema.attachment.id, ids),
        historicalAttachmentAvailable(userId),
        sql`octet_length(${schema.attachment.mimeType}) <= 256`,
      ),
    );
  const loaded = new Map(rows.map((file) => [file.id, file]));
  for (const [messageId, fileIds] of idsByMessage) {
    byMessage.set(
      messageId,
      fileIds.flatMap((id) => {
        const file = loaded.get(id);
        if (file) return [file];
        unavailable.add(messageId);
        return [];
      }),
    );
  }
  return { byMessage, unavailable };
}

/** Model-only enrichment: neither stored parts nor the saved user turn is mutated. */
export function withAttachmentContext(
  message: UIMessage,
  attachments: ModelAttachment[],
  supportsVision: boolean,
  unavailable = false,
): UIMessage {
  const parts: UIMessage['parts'] = [...message.parts];
  for (const attachment of attachments) {
    if (attachment.bytes && supportsVision) {
      parts.push({
        type: 'file',
        mediaType: attachment.mimeType,
        filename: attachment.filename,
        url: `data:${attachment.mimeType};base64,${attachment.bytes.toString('base64')}`,
      });
    } else {
      parts.push({
        type: 'text',
        text: attachment.extractedText
          ? `Attached file "${attachment.filename}":\n\n${attachment.extractedText}`
          : `Attached file "${attachment.filename}" (${attachment.mimeType}) could not be read.`,
      });
    }
  }
  if (unavailable) parts.push({ type: 'text', text: UNAVAILABLE_ATTACHMENT_TEXT });
  return { ...message, parts };
}
