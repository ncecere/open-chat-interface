import { logger } from '../../lib/logger.js';
import type { JobDefinition } from '../jobs/runner.js';
import { fillGeneration } from '../project-search/embedding.js';
import { GenerationStateError, vectorStore } from '../vector-store/index.js';
import { LEGACY_EMBEDDING_TABLE } from '../vector-store/pgvector.js';
import { embeddingsSettings } from './config.js';
import {
  dropExpiredGenerations,
  EMBEDDINGS_REBUILD_JOB,
  ensureGenerationStorage,
  previousReleaseGone,
  resolveGenerations,
  SwitchBlockedError,
  switchGeneration,
} from './generations.js';

/** A run of the rebuild job embeds for at most this long; the next tick continues. */
export const REBUILD_TICK_BUDGET_MS = 45_000;
const REBUILD_INTERVAL_MS = 60_000;

/**
 * The `embeddings.rebuild` job (v0.11 design, section 7), on `worker` and
 * `all` replicas under its advisory lock:
 *
 * 1. fills the generation being rebuilt, throttled (a pause between requests,
 *    the background migrations' database-pressure checks, a time budget) and
 *    resumable (each run embeds what is still missing);
 * 2. switches searches to it once it covers every passage, unless the
 *    upgrade from v0.10 is still in progress (generation 1's table);
 * 3. drops generations retired past their grace period, and cancelled ones.
 *
 * Does nothing to fill while meaning-based search is off or pgvector is not
 * enabled. Returns how many passages it embedded plus generations switched or
 * dropped, for the run record.
 */
export async function runEmbeddingRebuild(budgetMs = REBUILD_TICK_BUDGET_MS): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let touched = 0;
  const store = vectorStore();
  const settings = await embeddingsSettings({ fresh: true });
  const { current, filling } = await resolveGenerations({ fresh: true });
  if (settings.enabled && filling && (await store.health()).state === 'enabled') {
    if (current) await ensureGenerationStorage(current);
    if ((await ensureGenerationStorage(filling)) !== 'mismatch') {
      touched += await fillGeneration(filling, { deadline });
      if (await store.covers(filling)) {
        const blocked =
          current?.tableName === LEGACY_EMBEDDING_TABLE && !(await previousReleaseGone());
        if (!blocked) {
          try {
            await switchGeneration(filling.id, { force: false, actor: null });
            touched += 1;
          } catch (error) {
            // Cancelled or switched by an administrator meanwhile.
            if (!(error instanceof GenerationStateError || error instanceof SwitchBlockedError)) {
              throw error;
            }
            logger.info({ error: String(error) }, 'Embedding generation switch skipped');
          }
        }
      }
    }
  }
  touched += await dropExpiredGenerations();
  return touched;
}

/** The job runner's entry (services/jobs/index.ts). */
export function embeddingRebuildJobs(): JobDefinition[] {
  return [
    {
      name: EMBEDDINGS_REBUILD_JOB,
      intervalMs: REBUILD_INTERVAL_MS,
      run: () => runEmbeddingRebuild(),
    },
  ];
}
