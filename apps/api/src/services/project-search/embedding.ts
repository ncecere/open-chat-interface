import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { activeEmbedder, type Embedder, embedValues } from '../embeddings/embed.js';
import {
  EMBEDDING_TABLE,
  embeddingStorage,
  ensureEmbeddingTable,
  vectorLiteral,
  vectorType,
} from '../embeddings/storage.js';
import { recordEmbeddingUsage } from '../embeddings/usage.js';
import { jobMayContinue } from '../jobs/runner.js';

/**
 * Embedding project-file passages for meaning-based search.
 *
 * The `projects.embed-passages` job embeds passages that have no embedding
 * from the current model, a bounded number per run, in batches; uploads embed
 * the start of their own file straight away. Each batch is written as soon as
 * it is embedded, so a restart loses at most the batch in flight and the next
 * run carries on from what is missing. A file whose embedding fails is backed
 * off (`project_file_embedding_failure`) so it cannot hold up the rest.
 */

/** Passages embedded per run of the background job; the next tick continues. */
const EMBED_PASSAGES_PER_RUN = 512;
/** Passages sent in one embeddings request. */
export const EMBED_BATCH = 64;
/** Passages an upload embeds itself; the job does the rest of a large file. */
const UPLOAD_EMBED_PASSAGES = 128;
/** Stop a run after this many files fail in a row: the provider is likely down. */
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_ERROR_CHARS = 500;
const MINUTE_MS = 60_000;
/** Backoff after a file's n-th failure: 5, 10, 20 ... minutes, at most six hours. */
export function failureBackoffMs(failures: number): number {
  return Math.min(5 * MINUTE_MS * 2 ** Math.max(0, failures - 1), 6 * 60 * MINUTE_MS);
}

interface PendingPassage {
  attachmentId: string;
  userId: string;
  organizationId: string;
  ordinal: number;
  content: string;
}

/** Splits a run's passages into per-file batches of at most `size`, keeping their order. */
export function batchByFile<T extends { attachmentId: string }>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (const item of items) {
    const current = batches.at(-1);
    if (current && current[0]!.attachmentId === item.attachmentId && current.length < size) {
      current.push(item);
    } else {
      batches.push([item]);
    }
  }
  return batches;
}

/**
 * Passages of ready project files without an embedding from this model,
 * oldest file first, skipping files still backing off after a failure.
 */
async function pendingPassages(
  modelKey: string,
  limit: number,
  attachmentId?: string,
): Promise<PendingPassage[]> {
  const rows = await db.execute<{
    attachment_id: string;
    user_id: string;
    organization_id: string;
    ordinal: number;
    content: string;
  }>(sql`
    select c.attachment_id, a.user_id, a.organization_id, c.ordinal, c.content
    from project_file_chunk c
    join attachment a on a.id = c.attachment_id
    left join ${sql.identifier(EMBEDDING_TABLE)} e
      on e.attachment_id = c.attachment_id and e.ordinal = c.ordinal and e.model_key = ${modelKey}
    left join project_file_embedding_failure f
      on f.attachment_id = c.attachment_id and f.model_key = ${modelKey}
    where e.attachment_id is null
      and a.project_id is not null
      and a.upload_pending = false
      and a.deleted_at is null
      and (f.retry_at is null or f.retry_at <= now())
      ${attachmentId ? sql`and c.attachment_id = ${attachmentId}` : sql``}
    order by a.created_at, c.attachment_id, c.ordinal
    limit ${Math.max(1, limit)}
  `);
  return rows.map((row) => ({
    attachmentId: row.attachment_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    ordinal: Number(row.ordinal),
    content: row.content,
  }));
}

/** Writes one batch; a re-embedding replaces the previous model's vector in place. */
async function storeBatch(
  embedder: Embedder,
  storageSchema: string,
  batch: PendingPassage[],
  vectors: number[][],
): Promise<void> {
  const type = vectorType(storageSchema);
  await db.execute(sql`
    insert into ${sql.identifier(EMBEDDING_TABLE)} (attachment_id, ordinal, model_key, embedding)
    values ${sql.join(
      batch.map(
        (passage, index) =>
          sql`(${passage.attachmentId}, ${passage.ordinal}, ${embedder.key}, ${vectorLiteral(vectors[index]!)}::${type})`,
      ),
      sql`, `,
    )}
    on conflict (attachment_id, ordinal) do update
      set model_key = excluded.model_key, embedding = excluded.embedding, embedded_at = now()
  `);
}

/** Backs a file off; a failure under another model starts the count again. */
async function recordFailure(attachmentId: string, modelKey: string, error: unknown) {
  const lastError = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_CHARS,
  );
  const table = schema.projectFileEmbeddingFailure;
  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ failures: table.failures, modelKey: table.modelKey })
      .from(table)
      .where(eq(table.attachmentId, attachmentId))
      .for('update');
    const failures = previous?.modelKey === modelKey ? previous.failures + 1 : 1;
    const changes = {
      modelKey,
      failures,
      lastError,
      retryAt: new Date(Date.now() + failureBackoffMs(failures)),
      updatedAt: new Date(),
    };
    await tx
      .insert(table)
      .values({ attachmentId, ...changes })
      .onConflictDoUpdate({ target: table.attachmentId, set: changes });
  });
}

async function clearFailure(attachmentId: string) {
  await db
    .delete(schema.projectFileEmbeddingFailure)
    .where(eq(schema.projectFileEmbeddingFailure.attachmentId, attachmentId));
}

/**
 * Embeds one file's pending passages, batch by batch, and charges the tokens
 * to the file's owner. Returns how many passages were stored, and the error
 * if a batch failed (the file is then backed off).
 */
async function embedFilePassages(
  embedder: Embedder,
  storageSchema: string,
  passages: PendingPassage[],
): Promise<{ stored: number; error: unknown }> {
  const [first] = passages;
  if (!first) return { stored: 0, error: null };
  let stored = 0;
  let tokens = 0;
  let failure: unknown = null;
  try {
    for (const batch of batchByFile(passages, EMBED_BATCH)) {
      const result = await embedValues(
        embedder.model,
        batch.map((passage) => passage.content),
        { dimensions: embedder.settings.dimensions },
      );
      tokens += result.tokens;
      await storeBatch(embedder, storageSchema, batch, result.vectors);
      stored += batch.length;
    }
  } catch (error) {
    failure = error;
  }
  try {
    await recordEmbeddingUsage({
      organizationId: first.organizationId,
      userId: first.userId,
      modelId: embedder.settings.modelId,
      tokens,
      inputPriceMicros: embedder.settings.inputPriceMicros,
    });
    if (failure) await recordFailure(first.attachmentId, embedder.key, failure);
    else await clearFailure(first.attachmentId);
  } catch (error) {
    logger.warn({ error, attachmentId: first.attachmentId }, 'Embedding bookkeeping failed');
  }
  return { stored, error: failure };
}

function groupByFile(passages: PendingPassage[]): PendingPassage[][] {
  return batchByFile(passages, Number.MAX_SAFE_INTEGER);
}

/**
 * The `projects.embed-passages` job. Reads the setting fresh (not from this
 * replica's cache), creates the embedding table when meaning-based search is
 * on and pgvector is enabled, then embeds at most `limit` passages. Returns
 * how many it stored.
 */
export async function embedPendingProjectPassages(limit = EMBED_PASSAGES_PER_RUN): Promise<number> {
  const embedder = await activeEmbedder({ fresh: true });
  if (!embedder) return 0;
  const storage = await embeddingStorage();
  if (!storage) return 0;
  await ensureEmbeddingTable(embedder.settings.dimensions);
  let stored = 0;
  let consecutiveFailures = 0;
  let files = 0;
  for (const file of groupByFile(await pendingPassages(embedder.key, limit))) {
    // A failover may have taken the job's lock, or this replica is stopping.
    if (files++ > 0 && !(await jobMayContinue())) break;
    const result = await embedFilePassages(embedder, storage.schema, file);
    stored += result.stored;
    if (result.error) {
      logger.warn(
        { error: result.error, attachmentId: file[0]!.attachmentId },
        'Embedding project file passages failed; it will be retried later',
      );
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    } else {
      consecutiveFailures = 0;
    }
  }
  return stored;
}

/**
 * Embeds the start of a file just uploaded and indexed, when meaning-based
 * search is on and its storage is ready. Never raises: the upload has
 * succeeded, keyword search already covers the file, and the job does the rest.
 */
export async function embedUploadedProjectFile(attachmentId: string): Promise<void> {
  try {
    const embedder = await activeEmbedder();
    if (!embedder) return;
    const storage = await embeddingStorage();
    if (!storage || storage.dimensions !== embedder.settings.dimensions) return;
    const passages = await pendingPassages(embedder.key, UPLOAD_EMBED_PASSAGES, attachmentId);
    const result = await embedFilePassages(embedder, storage.schema, passages);
    if (result.error) {
      logger.warn(
        { error: result.error, attachmentId },
        'Embedding an uploaded project file failed; the job will retry it',
      );
    }
  } catch (error) {
    logger.warn({ error, attachmentId }, 'Embedding an uploaded project file failed');
  }
}
