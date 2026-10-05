import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POST_FOLDER, schema, sql } from '@oci/db';
import type { EmbeddingsSettings } from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { invalidateSettingsCache, updateSetting } from '../settings.js';
import { vectorStore } from '../vector-store/index.js';
import { configKey, LEGACY_EMBEDDING_TABLE } from '../vector-store/pgvector.js';
import {
  type EmbeddingConfig,
  type Generation,
  GenerationStateError,
  type TransactionExecutor,
} from '../vector-store/types.js';
import { embeddingsSettings } from './config.js';
import type { Embedder } from './embed.js';
import { resolveEmbeddingModel } from './model.js';

/**
 * Embedding generations (v0.11 design, section 7): what decides which
 * generation searches use, when a rebuild starts, switches and is cleaned up.
 * The vector store does the mechanics (services/vector-store).
 *
 * The `embeddings` instance setting keeps the shape v0.10 reads, and always
 * describes the **current** generation's model: during a rolling upgrade
 * v0.10 replicas read it, and embed into and search generation 1's table
 * (`project_file_embedding`) with it, exactly as v0.11 does. A model chosen
 * while a rebuild runs lives only in the filling generation's row, which
 * v0.10 never reads, until the switch writes it to the setting.
 */

export const EMBEDDINGS_REBUILD_JOB = 'embeddings.rebuild';

/** The release that introduced generations: its post-deploy steps mark the end of its upgrade. */
const GENERATIONS_RELEASE = '0.11.0';

let releaseSteps: string[] | null = null;

/** Post-deploy steps of the release that introduced generations (post/journal.json). */
function generationReleaseSteps(): string[] {
  if (!releaseSteps) {
    try {
      const journal = JSON.parse(
        readFileSync(join(DEFAULT_POST_FOLDER, 'journal.json'), 'utf8'),
      ) as {
        steps: Array<{ tag: string; release: string }>;
      };
      releaseSteps = journal.steps
        .filter((step) => step.release === GENERATIONS_RELEASE)
        .map((step) => step.tag);
    } catch (error) {
      logger.warn({ error }, 'Could not read the post-deploy journal');
      return ['missing-post-deploy-journal'];
    }
  }
  return releaseSteps;
}

/**
 * Whether no replica of a release before generations (v0.10) can still be
 * running. There is no record of which releases run, so this is the
 * operator's own statement that the upgrade is complete: every post-deploy
 * step of v0.11 is finished (`migrate --post` runs after the last replica is
 * replaced; a single instance runs it itself at startup). Until then
 * generation 1's table, which v0.10 reads and writes, is neither switched away
 * from nor dropped.
 */
export async function previousReleaseGone(): Promise<boolean> {
  if (releaseGone) return true;
  if (notGoneUntil > Date.now()) return false;
  const steps = generationReleaseSteps();
  let gone = steps.length === 0;
  if (!gone) {
    try {
      const [row] = await db.execute<{ finished: number }>(sql`
        select count(*)::int as finished from oci_post_migration
        where finished_at is not null and name = any(array[${sql.join(
          steps.map((step) => sql`${step}`),
          sql`, `,
        )}]::text[])
      `);
      gone = Number(row?.finished ?? 0) === steps.length;
    } catch (error) {
      logger.warn({ error }, 'Could not read post-deploy progress');
    }
  }
  // Finished is permanent; not finished is asked again after a while, as in
  // migrations/readiness.ts.
  if (gone) releaseGone = true;
  else notGoneUntil = Date.now() + NOT_GONE_TTL_MS;
  return gone;
}

const NOT_GONE_TTL_MS = 30_000;
let releaseGone = false;
let notGoneUntil = 0;

/** Test seam: forget the cached answer of `previousReleaseGone`. */
export function resetPreviousReleaseCache(): void {
  releaseGone = false;
  notGoneUntil = 0;
}

/** A switch the upgrade has not finished enough for. */
export class SwitchBlockedError extends Error {
  readonly reason = 'upgrade-in-progress' as const;
  constructor() {
    super(
      'Searches still use generation 1, whose table replicas of the previous release read during an upgrade. Finish the upgrade (migrate --post) first.',
    );
    this.name = 'SwitchBlockedError';
  }
}

function configOf(settings: EmbeddingsSettings): EmbeddingConfig | null {
  if (!settings.providerId || !settings.modelId || !settings.dimensions) return null;
  return {
    providerId: settings.providerId,
    modelId: settings.modelId,
    dimensions: settings.dimensions,
    inputPriceMicros: settings.inputPriceMicros,
  };
}

function settingFields(generation: Generation) {
  return {
    providerId: generation.providerId,
    modelId: generation.modelId,
    dimensions: generation.dimensions,
    inputPriceMicros: generation.inputPriceMicros,
  };
}

/**
 * The current and filling generations. The first time v0.11 needs them on an
 * instance configured under v0.10, the saved model becomes generation 1,
 * whose table is the one v0.10 created: nothing is copied or renamed.
 */
export async function resolveGenerations(options: { fresh?: boolean } = {}) {
  const store = vectorStore();
  const live = await store.liveGenerations();
  if (live.current || live.filling) return live;
  const config = configOf(await embeddingsSettings(options));
  if (!config) return live;
  try {
    return { current: await store.createGeneration(config, { state: 'current' }), filling: null };
  } catch (error) {
    // Another replica recorded it first.
    if (error instanceof GenerationStateError) return store.liveGenerations();
    throw error;
  }
}

/**
 * The configuration an administrator chose: the filling generation's model
 * while a rebuild runs, otherwise the current one's, otherwise what is saved.
 */
export async function desiredSettings(): Promise<{
  settings: EmbeddingsSettings;
  current: Generation | null;
  filling: Generation | null;
}> {
  const settings = await embeddingsSettings({ fresh: true });
  const { current, filling } = await resolveGenerations({ fresh: true });
  const target = filling ?? current;
  return {
    settings: target ? { ...settings, ...settingFields(target) } : settings,
    current,
    filling,
  };
}

/** The embeddings model of one generation, ready to call. */
export async function generationEmbedder(generation: Generation): Promise<Embedder> {
  return {
    settings: {
      enabled: true,
      providerId: generation.providerId,
      modelId: generation.modelId,
      dimensions: generation.dimensions,
      inputPriceMicros: generation.inputPriceMicros,
    },
    model: await resolveEmbeddingModel(generation.providerId, generation.modelId),
    key: generation.modelKey,
  };
}

/**
 * Creates a live generation's table when missing. Generation 1's table is
 * re-created at the right size when it has another (as v0.10 did) only while
 * the setting agrees with generation 1: a v0.10 replica whose administrator
 * chose another model mid-upgrade re-creates it at that size, and the two
 * releases must not take turns dropping it.
 */
export async function ensureGenerationStorage(generation: Generation) {
  const store = vectorStore();
  let replaceMismatched = false;
  if (generation.tableName === LEGACY_EMBEDDING_TABLE) {
    const config = configOf(await embeddingsSettings({ fresh: true }));
    replaceMismatched = config !== null && configKey(config) === generation.modelKey;
  }
  const result = await store.ensureStorage(generation, { replaceMismatched });
  if (result === 'mismatch') {
    logger.warn(
      { generation: generation.id },
      'The embedding table has another size than its generation; was the model changed on a replica of the previous release? Choose the model again on the Embeddings page.',
    );
  }
  return result;
}

export interface ModelChoice {
  current: Generation | null;
  filling: Generation | null;
  /** `created` / `recreated` / `ready` for the storage of what was chosen, when it was prepared. */
  storage: string | null;
  /** What happened to rebuilds: a new one started, one was cancelled (back to the current model), or neither. */
  rebuild: 'started' | 'cancelled' | 'replaced' | null;
}

/**
 * Applies a saved embeddings setting. A model that differs from the one
 * searches use becomes a filling generation (replacing a rebuild to another
 * model); choosing the current model again cancels a rebuild; the first model
 * of an instance is current at once, having nothing to keep serving.
 */
export async function applyModelChoice(
  next: EmbeddingsSettings,
  actorId: string | null,
): Promise<ModelChoice> {
  const store = vectorStore();
  let { current, filling } = await resolveGenerations({ fresh: true });
  let rebuild: ModelChoice['rebuild'] = null;
  const config = configOf(next);
  if (config) {
    const key = configKey(config);
    if (!current) {
      current = await store.createGeneration(config, { state: 'current', createdBy: actorId });
    } else if (key === current.modelKey) {
      if (filling) {
        await store.cancel(filling.id);
        filling = null;
        rebuild = 'cancelled';
      }
      if (current.inputPriceMicros !== config.inputPriceMicros) {
        await store.setPrice(current.id, config.inputPriceMicros);
        current = { ...current, inputPriceMicros: config.inputPriceMicros };
      }
    } else if (filling && key === filling.modelKey) {
      if (filling.inputPriceMicros !== config.inputPriceMicros) {
        await store.setPrice(filling.id, config.inputPriceMicros);
        filling = { ...filling, inputPriceMicros: config.inputPriceMicros };
      }
    } else {
      if (filling) await store.cancel(filling.id);
      rebuild = filling ? 'replaced' : 'started';
      filling = await store.createGeneration(config, { state: 'filling', createdBy: actorId });
    }
  }
  // The setting keeps describing what searches use (see the module comment).
  await updateSetting('embeddings', {
    enabled: next.enabled,
    ...(current
      ? settingFields(current)
      : {
          providerId: next.providerId,
          modelId: next.modelId,
          dimensions: next.dimensions,
          inputPriceMicros: next.inputPriceMicros,
        }),
  });
  let storage: string | null = null;
  if (next.enabled && current && (await store.health()).state === 'enabled') {
    try {
      storage = await ensureGenerationStorage(current);
      if (filling) storage = await ensureGenerationStorage(filling);
    } catch (error) {
      // The job retries; the setting itself is saved.
      logger.warn({ error }, 'Creating embedding storage failed');
    }
  }
  return { current, filling, storage, rebuild };
}

function graceMs(): number {
  return loadEnv().EMBEDDING_GENERATION_GRACE_MINUTES * 60_000;
}

/**
 * Writes the new current generation's model to the setting, inside the
 * switch. The organization is looked up before the transaction opens: a
 * transaction never waits for another pool connection.
 */
const mirrorInTransaction =
  (organizationId: string) => async (tx: TransactionExecutor, next: Generation) => {
    const fields = settingFields(next);
    await tx.execute(sql`
    insert into ${schema.instanceSetting} (organization_id, key, value)
    values (${organizationId}, 'embeddings', ${JSON.stringify(fields)}::jsonb)
    on conflict (organization_id, key) do update
      set value = ${schema.instanceSetting}.value || excluded.value, updated_at = now()
  `);
  };

export interface SwitchResult {
  current: Generation;
  retired: Generation | null;
  passages: { total: number; embedded: number };
  forced: boolean;
}

/**
 * Makes the filling generation current: searches move to it in one
 * transaction (each search reads the current generation as it starts), the
 * setting follows, and the previous generation is retired, its table dropped
 * after the grace period. Unless `force`, only when it covers every passage.
 * Audited, with the administrator or as automatic.
 */
export async function switchGeneration(
  generationId: number,
  options: { force: boolean; actor: { id: string; email: string } | null },
): Promise<SwitchResult> {
  const store = vectorStore();
  const { current, filling } = await resolveGenerations({ fresh: true });
  if (!filling || filling.id !== generationId) {
    throw new GenerationStateError(`Generation ${generationId} is not being filled`);
  }
  if (current?.tableName === LEGACY_EMBEDDING_TABLE && !(await previousReleaseGone())) {
    throw new SwitchBlockedError();
  }
  if ((await store.storageState(filling)) !== 'ready') {
    throw new GenerationStateError(`The storage of generation ${generationId} is not ready yet`);
  }
  const covered = await store.covers(filling);
  if (!covered && !options.force) {
    throw new GenerationStateError(`Generation ${generationId} does not cover every passage yet`);
  }
  const progress = await store.fillProgress(filling);
  const result = await store.switchTo(generationId, {
    graceMs: graceMs(),
    forced: !covered,
    alsoInTransaction: mirrorInTransaction(await getDefaultOrganizationId()),
  });
  invalidateSettingsCache('embeddings');
  await recordAudit({
    actorUserId: options.actor?.id ?? null,
    actorEmail: options.actor?.email ?? null,
    action: 'embeddings.generation.switch',
    targetType: 'embedding_generation',
    targetId: String(generationId),
    metadata: {
      generation: generationId,
      providerId: result.current.providerId,
      modelId: result.current.modelId,
      dimensions: result.current.dimensions,
      previous: result.retired?.id ?? null,
      passages: { total: progress.total, embedded: progress.embedded },
      forced: !covered,
      automatic: options.actor === null,
    },
  });
  return {
    current: result.current,
    retired: result.retired,
    passages: { total: progress.total, embedded: progress.embedded },
    forced: !covered,
  };
}

/**
 * Abandons the rebuild: searches stay on the current generation, the setting
 * already describes it, and the filling generation's table is dropped by the
 * next run of the job. Audited.
 */
export async function cancelRebuild(
  generationId: number,
  actor: { id: string; email: string },
): Promise<Generation> {
  const store = vectorStore();
  const { filling } = await resolveGenerations({ fresh: true });
  if (!filling || filling.id !== generationId) {
    throw new GenerationStateError(`Generation ${generationId} is not being filled`);
  }
  const progress = await store.fillProgress(filling);
  const cancelled = await store.cancel(generationId);
  if (!cancelled) throw new GenerationStateError(`Generation ${generationId} is not being filled`);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'embeddings.generation.cancel',
    targetType: 'embedding_generation',
    targetId: String(generationId),
    metadata: {
      generation: generationId,
      providerId: cancelled.providerId,
      modelId: cancelled.modelId,
      dimensions: cancelled.dimensions,
      passages: { total: progress.total, embedded: progress.embedded },
    },
  });
  return cancelled;
}

/**
 * Drops the tables of generations retired past their grace period, and of
 * cancelled ones, recording each (audited, as automatic). Generation 1's table
 * waits for the end of the upgrade (`previousReleaseGone`).
 */
export async function dropExpiredGenerations(): Promise<number> {
  const store = vectorStore();
  const candidates = (await store.listGenerations()).filter(
    (generation) =>
      generation.state === 'cancelled' ||
      (generation.state === 'retired' &&
        generation.dropAfter !== null &&
        generation.dropAfter.getTime() <= Date.now()),
  );
  if (candidates.length === 0) return 0;
  const gone = await previousReleaseGone();
  let dropped = 0;
  for (const generation of candidates) {
    try {
      if (!(await store.dropStorage(generation, { previousReleaseGone: gone }))) continue;
    } catch (error) {
      // A lock timeout under load: the next run tries again.
      logger.warn({ error, generation: generation.id }, 'Dropping an embedding generation failed');
      continue;
    }
    dropped += 1;
    await recordAudit({
      action: 'embeddings.generation.drop',
      targetType: 'embedding_generation',
      targetId: String(generation.id),
      metadata: {
        generation: generation.id,
        table: generation.tableName,
        modelId: generation.modelId,
        state: generation.state,
      },
    });
  }
  return dropped;
}
