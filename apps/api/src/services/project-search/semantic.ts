import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { stripControls } from '../../lib/text.js';
import { embeddingsSettings } from '../embeddings/config.js';
import { embedValues } from '../embeddings/embed.js';
import { generationEmbedder, resolveGenerations } from '../embeddings/generations.js';
import { recordEmbeddingUsage } from '../embeddings/usage.js';
import { getDefaultOrganizationId } from '../organization.js';
import { type Generation, vectorStore } from '../vector-store/index.js';
import { similarEnough } from './relevance.js';
import { type ChunkRow, type RetrievedChunk, scopedChunks, toChunk } from './retrieval.js';

/**
 * Meaning-based (vector) retrieval over one project's file chunks. Used only
 * when an administrator has configured an embeddings model and the database
 * has pgvector; otherwise, or when anything here fails, the caller keeps
 * keyword search alone, exactly as in v0.8.
 *
 * Searches use the **current** embeddings generation, with the model that
 * generation was embedded with (v0.11): while a new model is being filled in
 * the background, questions keep being embedded and compared with the
 * previous one, so search never goes empty during a rebuild.
 */

/** Only the start of a long message is embedded, as for keyword search. */
const QUERY_MAX_CHARS = 2000;
/** A reply waits at most this long for the question's embedding. */
const QUERY_TIMEOUT_MS = 8_000;

type Scope = { userId: string; projectId: string; fileIds: string[] };

/**
 * The chunks nearest to `vector` by cosine distance, nearest first, leaving
 * out any less similar than `SEMANTIC_MIN_SIMILARITY` (relevance.ts): a vector
 * search otherwise returns its top results however unrelated they are. The
 * vector store scans this person's project's own vectors in the generation
 * (it applies the person-and-project filter itself); the passages are then
 * read through the same scope as keyword search, which checks ownership and
 * project again.
 */
export async function vectorRankProjectChunks(
  scope: Scope,
  generation: Generation,
  vector: number[],
  limit: number,
): Promise<RetrievedChunk[]> {
  if (scope.fileIds.length === 0 || limit <= 0) return [];
  const hits = similarEnough(
    await vectorStore().search(
      generation,
      { personId: scope.userId, projectId: scope.projectId, fileIds: scope.fileIds },
      vector,
      limit,
    ),
  );
  if (hits.length === 0) return [];
  const rows = await db.execute<ChunkRow>(sql`
    with scope as materialized (${scopedChunks(scope)})
    select s.attachment_id, s.filename, s.ordinal, s.start_offset, s.end_offset, s.content
    from scope s
    join unnest(
      array[${sql.join(
        hits.map((hit) => sql`${hit.attachmentId}`),
        sql`, `,
      )}]::text[],
      array[${sql.join(
        hits.map((hit) => sql`${hit.ordinal}`),
        sql`, `,
      )}]::int[]
    ) as hit(attachment_id, ordinal)
      on hit.attachment_id = s.attachment_id and hit.ordinal = s.ordinal
  `);
  const byKey = new Map(rows.map((row) => [`${row.attachment_id}\u0000${row.ordinal}`, row]));
  return hits.flatMap((hit) => {
    const row = byKey.get(`${hit.attachmentId}\u0000${hit.ordinal}`);
    return row ? [toChunk(row)] : [];
  });
}

/**
 * The chunks closest in meaning to a message, or null when meaning-based
 * search is not available for this turn: switched off, pgvector not enabled,
 * the current generation's storage not (yet) ready, nothing in the project
 * embedded in it yet, or any failure, including the embeddings call itself.
 * A failure is logged and never fails the reply. The question's embedding is
 * a usage event of the person asking.
 */
export async function semanticProjectChunks(
  scope: Scope,
  raw: string,
  limit: number,
): Promise<RetrievedChunk[] | null> {
  const text = stripControls(raw.normalize('NFC').slice(0, QUERY_MAX_CHARS)).trim();
  if (!text || scope.fileIds.length === 0 || limit <= 0) return null;
  try {
    if (!(await embeddingsSettings()).enabled) return null;
    const { current } = await resolveGenerations();
    if (!current) return null;
    const store = vectorStore();
    const filter = { personId: scope.userId, projectId: scope.projectId, fileIds: scope.fileIds };
    if (!(await store.hasVectors(current, filter))) return null;
    const embedder = await generationEmbedder(current);
    const { vectors, tokens } = await embedValues(embedder.model, [text], {
      dimensions: current.dimensions,
      abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      maxRetries: 0,
    });
    await recordEmbeddingUsage({
      organizationId: await getDefaultOrganizationId(),
      userId: scope.userId,
      modelId: current.modelId,
      tokens,
      inputPriceMicros: current.inputPriceMicros,
    });
    return await vectorRankProjectChunks(scope, current, vectors[0]!, limit);
  } catch (error) {
    logger.warn(
      { error, projectId: scope.projectId },
      'Meaning-based project search failed; using keyword search only',
    );
    return null;
  }
}
