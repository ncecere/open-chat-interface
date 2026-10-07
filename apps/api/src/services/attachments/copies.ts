import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, schema } from '@oci/db';
import type { db } from '../../db/index.js';
import { adjustStorageUsage } from '../storage/usage.js';

/**
 * A fork's or an edit's own rows for the files its messages show (#358).
 *
 * A message copied into a fork, or an edited question that keeps its files,
 * used to carry the original's attachment ids, so the file belonged to the
 * conversation it was first sent in and was deleted with it. Now the copy gets
 * an attachment row of its own for each file: the same stored object, name,
 * type, size and extracted text, owned by the copied message. Access, the
 * storage meter, the trash and every deletion then work per conversation, as
 * they do for artifacts; the object itself is deleted only when the last row
 * using it is (migration 0045, services/storage/reaper.ts).
 *
 * Product decision: a copy counts against the person's storage allowance like
 * the file it copies (the meter and the Settings list add up the same rows),
 * but making a fork is never refused for lack of space: the fork is a copy of
 * something already stored, and refusing it would lose the conversation's
 * answer, not save the space. The allowance bites at the next upload.
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Part = Record<string, unknown>;

type Source = typeof schema.attachment.$inferSelect;

export interface PlannedFile {
  /** The new row's id, already written into the message's parts. */
  id: string;
  source: Source;
}

export interface FilePlan {
  /** The parts to store: the same, with each file's part pointing at its own row. */
  parts: Part[];
  files: PlannedFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function referencedId(part: unknown): string | null {
  if (!isRecord(part) || part.type !== 'data-attachment' || !isRecord(part.data)) return null;
  return typeof part.data.id === 'string' && part.data.id.length > 0 ? part.data.id : null;
}

/** The path a stored file is served from; the part the chat route writes has the same. */
export const attachmentContentUrl = (id: string) => `/api/attachments/${id}/content`;

/**
 * Plans the files of messages about to be copied: for each `data-attachment`
 * part that names one of the person's live, sent chat files, a new id and the
 * part rewritten to it. A part that names anything else (a file since removed,
 * another person's, a project file) is copied as it is, so a fork shows a
 * removed file as removed, as its source does.
 *
 * The source rows are locked `for share` in id order until the transaction
 * ends, so the file cannot be deleted between being read and being copied; the
 * caller inserts the planned rows in the same transaction (`insertPlannedFiles`).
 */
export async function planFileCopies(
  tx: Transaction,
  userId: string,
  partsOfMessages: Part[][],
): Promise<FilePlan[]> {
  const wanted = [
    ...new Set(
      partsOfMessages.flatMap((parts) => parts.flatMap((part) => referencedId(part) ?? [])),
    ),
  ];
  const sources = new Map<string, Source>();
  if (wanted.length > 0) {
    const rows = await tx
      .select()
      .from(schema.attachment)
      .where(
        and(
          inArray(schema.attachment.id, wanted),
          eq(schema.attachment.userId, userId),
          eq(schema.attachment.uploadPending, false),
          isNull(schema.attachment.deletedAt),
          isNull(schema.attachment.projectId),
          // A file that was sent, not one still waiting in a composer.
          isNotNull(schema.attachment.messageId),
        ),
      )
      .orderBy(asc(schema.attachment.id))
      .for('share');
    for (const row of rows) if (row.storageKey !== 'pending') sources.set(row.id, row);
  }
  return partsOfMessages.map((parts) => {
    // One copy per file and message, however often its part appears.
    const own = new Map<string, PlannedFile>();
    const rewritten = parts.map((part) => {
      const sourceId = referencedId(part);
      const source = sourceId ? sources.get(sourceId) : undefined;
      if (!sourceId || !source) return part;
      let copy = own.get(sourceId);
      if (!copy) {
        copy = { id: randomUUID(), source };
        own.set(sourceId, copy);
      }
      const data = (part as { data: Part }).data;
      return { ...part, data: { ...data, id: copy.id, url: attachmentContentUrl(copy.id) } };
    });
    return { parts: rewritten, files: [...own.values()] };
  });
}

/** Inserts the rows planned for the stored messages (`messageId`) and counts them in the person's storage. */
export async function insertPlannedFiles(
  tx: Transaction,
  userId: string,
  entries: Array<{ messageId: string; files: PlannedFile[] }>,
): Promise<void> {
  const values = entries.flatMap((entry) =>
    entry.files.map(({ id, source }) => ({
      id,
      organizationId: source.organizationId,
      userId,
      messageId: entry.messageId,
      filename: source.filename,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      storageKey: source.storageKey,
      thumbnailKey: source.thumbnailKey,
      extractedText: source.extractedText,
      // When the file was uploaded, as in the Settings list for the original.
      createdAt: source.createdAt,
    })),
  );
  if (values.length === 0) return;
  await tx.insert(schema.attachment).values(values);
  await adjustStorageUsage(tx, {
    organizationId: values[0]!.organizationId,
    userId,
    liveBytes: values.reduce((total, value) => total + value.sizeBytes, 0),
    liveFiles: values.length,
  });
}
