import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { stripControls } from '../../lib/text.js';
import { activeEmbedder, embedValues } from '../embeddings/embed.js';
import {
  cosineDistance,
  EMBEDDING_TABLE,
  embeddingStorage,
  vectorLiteral,
  vectorType,
} from '../embeddings/storage.js';
import { recordEmbeddingUsage } from '../embeddings/usage.js';
import { getDefaultOrganizationId } from '../organization.js';
import { similarEnough } from './relevance.js';
import {
  type ChunkRow,
  type RetrievedChunk,
  scopedChunks,
  textArray,
  toChunk,
} from './retrieval.js';

/**
 * Meaning-based (vector) retrieval over one project's file chunks. Used only
 * when an administrator has configured an embeddings model and the database
 * has pgvector; otherwise, or when anything here fails, the caller keeps
 * keyword search alone, exactly as in v0.8.
 */

/** Only the start of a long message is embedded, as for keyword search. */
const QUERY_MAX_CHARS = 2000;
/** A reply waits at most this long for the question's embedding. */
const QUERY_TIMEOUT_MS = 8_000;

type Scope = { userId: string; projectId: string; fileIds: string[] };

/**
 * The chunks nearest to `vector` by cosine distance, nearest first, leaving
 * out any less similar than `SEMANTIC_MIN_SIMILARITY` (relevance.ts): a vector
 * search otherwise returns its top results however unrelated they are. An
 * exact scan of this project's own embeddings from the current model: a
 * project is small enough that no approximate index is needed, and none could
 * restrict itself to one project anyway. Ownership and project are re-checked
 * through the same scope as keyword search.
 */
export async function vectorRankProjectChunks(
  scope: Scope,
  storage: { schema: string },
  modelKey: string,
  vector: number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  if (scope.fileIds.length === 0 || limit <= 0) return [];
  const rows = await db.execute<ChunkRow & { distance: number }>(sql`
    with scope as materialized (${scopedChunks(scope)})
    select s.attachment_id, s.filename, s.ordinal, s.start_offset, s.end_offset, s.content,
           (e.embedding ${cosineDistance(storage.schema)} ${vectorLiteral(vector)}::${vectorType(storage.schema)})::float8
             as distance
    from scope s
    join ${sql.identifier(EMBEDDING_TABLE)} e
      on e.attachment_id = s.attachment_id and e.ordinal = s.ordinal
    where e.model_key = ${modelKey}
    order by distance, s.attachment_id, s.ordinal
    limit ${limit}
  `);
  // Nearest first, so filtering after the limit keeps the same prefix.
  return similarEnough(rows.map((row) => ({ ...row, distance: Number(row.distance) }))).map(
    toChunk,
  );
}

/** Whether any of these files has an embedding from the current model yet. */
async function anyEmbedded(fileIds: string[], modelKey: string): Promise<boolean> {
  const [row] = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from ${sql.identifier(EMBEDDING_TABLE)}
      where attachment_id = any(${textArray(fileIds)}) and model_key = ${modelKey}
    ) as found
  `);
  return row?.found === true;
}

/**
 * The chunks closest in meaning to a message, or null when meaning-based
 * search is not available for this turn: switched off, pgvector not enabled,
 * the storage not (yet) matching the model, nothing in the project embedded
 * yet, or any failure, including the embeddings call itself. A failure is
 * logged and never fails the reply. The question's embedding is a usage event
 * of the person asking.
 */
export async function semanticProjectChunks(
  scope: Scope,
  raw: string,
  limit: number,
): Promise<RetrievedChunk[] | null> {
  const text = stripControls(raw.normalize('NFC').slice(0, QUERY_MAX_CHARS)).trim();
  if (!text || scope.fileIds.length === 0 || limit <= 0) return null;
  try {
    const embedder = await activeEmbedder();
    if (!embedder) return null;
    const storage = await embeddingStorage();
    if (!storage || storage.dimensions !== embedder.settings.dimensions) return null;
    if (!(await anyEmbedded(scope.fileIds, embedder.key))) return null;
    const { vectors, tokens } = await embedValues(embedder.model, [text], {
      dimensions: embedder.settings.dimensions,
      abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      maxRetries: 0,
    });
    await recordEmbeddingUsage({
      organizationId: await getDefaultOrganizationId(),
      userId: scope.userId,
      modelId: embedder.settings.modelId,
      tokens,
      inputPriceMicros: embedder.settings.inputPriceMicros,
    });
    return await vectorRankProjectChunks(scope, storage, embedder.key, vectors[0]!, limit);
  } catch (error) {
    logger.warn(
      { error, projectId: scope.projectId },
      'Meaning-based project search failed; using keyword search only',
    );
    return null;
  }
}
