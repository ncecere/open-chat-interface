import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { embeddingsSettings } from '../embeddings/config.js';
import { type Embedder, embedValues } from '../embeddings/embed.js';
import {
  ensureGenerationStorage,
  generationEmbedder,
  resolveGenerations,
} from '../embeddings/generations.js';
import { recordEmbeddingUsage } from '../embeddings/usage.js';
import { jobMayContinue } from '../jobs/runner.js';
import { databasePressure } from '../migrations/throttle.js';
import {
  type Generation,
  type PassageRef,
  type PendingPassage,
  vectorStore,
} from '../vector-store/index.js';

export { failureBackoffMs } from '../vector-store/pgvector.js';

/**
 * Embedding project-file passages for meaning-based search.
 *
 * Vectors belong to a generation (v0.11): one embeddings configuration and
 * its own storage (services/embeddings/generations.ts). The
 * `projects.embed-passages` job embeds passages that have no vector in the
 * **current** generation, a bounded number per run, in batches; the
 * `embeddings.rebuild` job fills a **filling** generation after a model
 * change (`fillGeneration`); uploads embed the start of their own file into
 * both. Each batch is written as soon as it is embedded, so a restart loses at
 * most the batch in flight and the next run carries on from what is missing.
 * A file whose embedding fails is backed off, per generation, so it cannot
 * hold up the rest.
 */

/** Passages embedded per run of the background job; the next tick continues. */
const EMBED_PASSAGES_PER_RUN = 512;
/** Passages sent in one embeddings request. */
export const EMBED_BATCH = 64;
/** Passages an upload embeds itself, per generation; the jobs do the rest of a large file. */
const UPLOAD_EMBED_PASSAGES = 128;
/** Stop a run after this many files fail in a row: the provider is likely down. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Passages a rebuild reads at a time. */
const FILL_PAGE = 512;

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
 * Embeds one file's pending passages into a generation, batch by batch, and
 * charges the tokens to the file's owner. Returns how many passages were
 * stored, and the error if a batch failed (the file is then backed off).
 * `beforeBatch` (given the next batch's size) may pause, or stop it before a
 * batch (a rebuild's budget and throttle).
 */
async function embedFilePassages(
  embedder: Embedder,
  generation: Generation,
  passages: PendingPassage[],
  beforeBatch?: (size: number) => Promise<boolean>,
): Promise<{ stored: number; error: unknown }> {
  const [first] = passages;
  if (!first) return { stored: 0, error: null };
  const store = vectorStore();
  let stored = 0;
  let tokens = 0;
  let failure: unknown = null;
  try {
    for (const batch of batchByFile(passages, EMBED_BATCH)) {
      if (beforeBatch && !(await beforeBatch(batch.length))) break;
      const result = await embedValues(
        embedder.model,
        batch.map((passage) => passage.content),
        { dimensions: generation.dimensions },
      );
      tokens += result.tokens;
      await store.upsert(
        generation,
        batch.map((passage, position) => ({
          attachmentId: passage.attachmentId,
          ordinal: passage.ordinal,
          vector: result.vectors[position]!,
        })),
      );
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
    if (failure) await store.recordFailure(generation, first.attachmentId, failure);
    else if (stored > 0) await store.clearFailure(generation, first.attachmentId);
  } catch (error) {
    logger.warn({ error, attachmentId: first.attachmentId }, 'Embedding bookkeeping failed');
  }
  return { stored, error: failure };
}

function groupByFile(passages: PendingPassage[]): PendingPassage[][] {
  return batchByFile(passages, Number.MAX_SAFE_INTEGER);
}

/**
 * The current generation, its storage created when missing, when
 * meaning-based search is on and pgvector is enabled; otherwise null.
 */
async function currentGenerationReady(): Promise<Generation | null> {
  const settings = await embeddingsSettings({ fresh: true });
  if (!settings.enabled) return null;
  const { current } = await resolveGenerations({ fresh: true });
  if (!current) return null;
  if ((await vectorStore().health()).state !== 'enabled') return null;
  return (await ensureGenerationStorage(current)) === 'mismatch' ? null : current;
}

/**
 * The `projects.embed-passages` job. Reads the setting fresh (not from this
 * replica's cache), creates the current generation's storage when
 * meaning-based search is on and pgvector is enabled, then embeds at most
 * `limit` passages missing from it. Returns how many it stored.
 */
export async function embedPendingProjectPassages(limit = EMBED_PASSAGES_PER_RUN): Promise<number> {
  const current = await currentGenerationReady();
  if (!current) return 0;
  const embedder = await generationEmbedder(current);
  const pending = await vectorStore().pendingPassages(current, { limit });
  let stored = 0;
  let consecutiveFailures = 0;
  let files = 0;
  for (const file of groupByFile(pending)) {
    // A failover may have taken the job's lock, or this replica is stopping.
    if (files++ > 0 && !(await jobMayContinue())) break;
    const result = await embedFilePassages(embedder, current, file);
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

export interface FillOptions {
  /** Stop starting batches at this time (ms since the epoch). */
  deadline: number;
  /**
   * Pause after every `EMBED_BATCH` passages sent (not every request: files
   * are often far smaller than a batch, and one request per file is kept so
   * that each request is charged to one owner).
   */
  pauseMs?: number;
  /** Store at most this many passages. */
  limit?: number;
}

/**
 * Fills a generation being rebuilt, from where it stands, until the deadline,
 * the database is under pressure, the job must stop, or nothing is missing.
 * Walks the passages once in key order (a cursor within the run; a later run
 * starts again and skips what is there), so a crash loses at most the batch
 * in flight and repeats no stored passage. Returns how many it stored.
 */
export async function fillGeneration(
  generation: Generation,
  options: FillOptions,
): Promise<number> {
  const store = vectorStore();
  const env = loadEnv();
  const pauseMs = options.pauseMs ?? env.EMBEDDING_REBUILD_PAUSE_MS;
  const limits = {
    maxReplicationLagMs: env.BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS,
    maxTransactionAgeMs: env.BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS,
  };
  const embedder = await generationEmbedder(generation);
  let after: PassageRef = { attachmentId: '', ordinal: -1 };
  let stored = 0;
  let consecutiveFailures = 0;
  let sinceLastPause = 0;
  const mayGoOn = async () => {
    if (Date.now() >= options.deadline || !(await jobMayContinue())) return false;
    // The pool's own client, as the background migrations' throttle uses.
    const pressure = await databasePressure(db.$client, limits);
    if (pressure) {
      logger.info(
        { generation: generation.id, pressure },
        'Embedding rebuild waits: database busy',
      );
      return false;
    }
    return true;
  };
  while (await mayGoOn()) {
    const room = Math.min(FILL_PAGE, (options.limit ?? Number.POSITIVE_INFINITY) - stored);
    if (room <= 0) break;
    const page = await store.pendingPassages(generation, { limit: room, after });
    if (page.length === 0) break;
    const last = page.at(-1)!;
    after = { attachmentId: last.attachmentId, ordinal: last.ordinal };
    for (const file of groupByFile(page)) {
      let stopped = false;
      const result = await embedFilePassages(embedder, generation, file, async (size) => {
        if (sinceLastPause + size > EMBED_BATCH) {
          if (pauseMs > 0) await sleep(pauseMs);
          sinceLastPause = 0;
          if (!(await mayGoOn())) {
            stopped = true;
            return false;
          }
        }
        sinceLastPause += size;
        return true;
      });
      stored += result.stored;
      if (result.error) {
        logger.warn(
          { error: result.error, attachmentId: file[0]!.attachmentId, generation: generation.id },
          'Embedding project file passages for a rebuild failed; it will be retried later',
        );
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return stored;
      } else {
        consecutiveFailures = 0;
      }
      if (stopped) return stored;
    }
  }
  return stored;
}

/**
 * Embeds the start of a file just uploaded and indexed into every live
 * generation whose storage is ready: the current one, and the one being
 * filled during a rebuild, so neither misses it. Never raises: the upload has
 * succeeded, keyword search already covers the file, and the jobs do the rest.
 */
export async function embedUploadedProjectFile(attachmentId: string): Promise<void> {
  try {
    if (!(await embeddingsSettings()).enabled) return;
    const store = vectorStore();
    const { current, filling } = await resolveGenerations();
    for (const generation of [current, filling]) {
      if (!generation) continue;
      try {
        if ((await store.storageState(generation)) !== 'ready') continue;
        const embedder = await generationEmbedder(generation);
        const passages = await store.pendingPassages(generation, {
          limit: UPLOAD_EMBED_PASSAGES,
          attachmentId,
        });
        const result = await embedFilePassages(embedder, generation, passages);
        if (result.error) {
          logger.warn(
            { error: result.error, attachmentId, generation: generation.id },
            'Embedding an uploaded project file failed; the job will retry it',
          );
        }
      } catch (error) {
        logger.warn(
          { error, attachmentId, generation: generation.id },
          'Embedding an uploaded project file failed',
        );
      }
    }
  } catch (error) {
    logger.warn({ error, attachmentId }, 'Embedding an uploaded project file failed');
  }
}
