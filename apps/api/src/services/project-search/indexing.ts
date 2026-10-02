import { and, asc, eq, isNotNull, isNull, schema } from '@oci/db';
import type { ProjectFileIndex } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { chunkText } from './chunking.js';

/** Files chunked per run of the background job; the next tick continues. */
const INDEX_FILES_PER_RUN = 50;
const INSERT_BATCH = 200;

/**
 * Chunks one ready project file and stores its chunks, in one transaction.
 *
 * Idempotent and safe to run concurrently: the `project_file_index` row is
 * inserted first with ON CONFLICT DO NOTHING, so a second indexer either waits
 * for the first to commit and then finds the row, or proceeds if the first
 * rolled back. A crash part-way rolls everything back and leaves the file to
 * the next attempt. The file row is read FOR KEY SHARE, so a concurrent
 * deletion waits rather than racing the chunk inserts.
 *
 * Returns false when the file is not a ready project file or was already
 * indexed.
 */
export async function indexProjectFile(attachmentId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [file] = await tx
      .select({ id: schema.attachment.id, extractedText: schema.attachment.extractedText })
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.id, attachmentId),
          isNotNull(schema.attachment.projectId),
          eq(schema.attachment.uploadPending, false),
          isNull(schema.attachment.deletedAt),
        ),
      )
      .for('key share');
    if (!file) return false;
    const { chunks, truncated } = chunkText(file.extractedText ?? '');
    const claimed = await tx
      .insert(schema.projectFileIndex)
      .values({ attachmentId, chunkCount: chunks.length, truncated })
      .onConflictDoNothing()
      .returning({ attachmentId: schema.projectFileIndex.attachmentId });
    if (claimed.length === 0) return false;
    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
      await tx.insert(schema.projectFileChunk).values(
        chunks.slice(offset, offset + INSERT_BATCH).map((chunk) => ({
          attachmentId,
          ordinal: chunk.ordinal,
          startOffset: chunk.start,
          endOffset: chunk.end,
          content: chunk.content,
        })),
      );
    }
    return true;
  });
}

/**
 * Indexes a file just uploaded to a project. A failure is logged, not raised:
 * the upload has already succeeded, the file is used whole meanwhile, and the
 * background job retries it.
 */
export async function indexUploadedProjectFile(attachmentId: string): Promise<void> {
  try {
    await indexProjectFile(attachmentId);
  } catch (error) {
    logger.warn({ error, attachmentId }, 'Project file indexing failed; the job will retry it');
  }
}

/**
 * The `projects.index-files` job: chunks project files that have no index row
 * yet, oldest first, at most `limit` per run. This covers files added before
 * v0.8 and any upload whose own indexing failed. Each file commits on its own,
 * so a restart loses at most the file in progress, which the next run redoes.
 * Returns how many files it indexed.
 */
export async function indexPendingProjectFiles(limit = INDEX_FILES_PER_RUN): Promise<number> {
  const pending = await db
    .select({ id: schema.attachment.id })
    .from(schema.attachment)
    .leftJoin(
      schema.projectFileIndex,
      eq(schema.projectFileIndex.attachmentId, schema.attachment.id),
    )
    .where(
      and(
        isNotNull(schema.attachment.projectId),
        eq(schema.attachment.uploadPending, false),
        isNull(schema.attachment.deletedAt),
        isNull(schema.projectFileIndex.attachmentId),
      ),
    )
    .orderBy(asc(schema.attachment.createdAt), asc(schema.attachment.id))
    .limit(Math.max(1, limit));
  let indexed = 0;
  for (const file of pending) {
    try {
      if (await indexProjectFile(file.id)) indexed += 1;
    } catch (error) {
      // One bad file must not stop the rest; it is retried on the next run.
      logger.warn({ error, attachmentId: file.id }, 'Project file indexing failed');
    }
  }
  return indexed;
}

/** The index status shown for a project file. */
export function projectFileIndexStatus(chunkCount: number | null | undefined): ProjectFileIndex {
  if (chunkCount === null || chunkCount === undefined) return { status: 'pending', passages: 0 };
  if (chunkCount === 0) return { status: 'no-text', passages: 0 };
  return { status: 'indexed', passages: chunkCount };
}
