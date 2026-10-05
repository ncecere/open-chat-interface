import { asc, schema, sql } from '@oci/db';
import {
  type EmbeddingGenerationStatus,
  type EmbeddingsStatus,
  providerCanEmbed,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { type Generation, vectorStore } from '../vector-store/index.js';
import { LEGACY_EMBEDDING_TABLE } from '../vector-store/pgvector.js';
import { desiredSettings, previousReleaseGone } from './generations.js';

/** Characters per token used for cost estimates (English text with common tokenizers). */
const CHARS_PER_TOKEN = 4;
/** Passages sampled for their average length. */
const SAMPLE_ROWS = 5_000;

/**
 * The average passage length in tokens, estimated from characters on a
 * sample of passages, so a cost estimate does not read every passage.
 */
async function averagePassageTokens(): Promise<number> {
  const [stats] = await db.execute<{ rows: number }>(sql`
    select greatest(reltuples, 0)::float8 as rows from pg_class
    where oid = 'project_file_chunk'::regclass
  `);
  const rows = Number(stats?.rows ?? 0);
  const percent = rows > 0 ? Math.min(100, Math.max(0.01, (SAMPLE_ROWS * 100) / rows)) : 100;
  let [row] = await db.execute<{ chars: number | null }>(sql`
    select avg(char_length(content))::float8 as chars
    from (
      select content from project_file_chunk tablesample system (${sql.raw(percent.toFixed(4))})
      limit ${SAMPLE_ROWS}
    ) sample
  `);
  if (row?.chars == null) {
    [row] = await db.execute<{ chars: number | null }>(sql`
      select avg(char_length(content))::float8 as chars
      from (select content from project_file_chunk limit ${SAMPLE_ROWS}) sample
    `);
  }
  const chars = Number(row?.chars ?? 0);
  return chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0;
}

/** Passages of live project files. */
async function livePassageCount(): Promise<number> {
  const [row] = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from project_file_chunk c
    join attachment a on a.id = c.attachment_id
    where a.project_id is not null and a.upload_pending = false and a.deleted_at is null
  `);
  return Number(row?.total ?? 0);
}

/** Passages a new model would embed, and their estimated average length in tokens. */
export async function passageEstimate(): Promise<{ passages: number; averageTokens: number }> {
  const [passages, averageTokens] = await Promise.all([livePassageCount(), averagePassageTokens()]);
  return { passages, averageTokens };
}

async function generationStatus(
  generation: Generation,
  detail: boolean,
): Promise<EmbeddingGenerationStatus> {
  const store = vectorStore();
  const storage = generation.state === 'dropped' ? 'missing' : await store.storageState(generation);
  const storageReady = storage === 'ready';
  const progress = detail
    ? await store.fillProgress(generation)
    : { total: 0, embedded: 0, perMinute: 0 };
  const failures = detail ? await store.failureSummary(generation) : { files: 0, lastError: null };
  const missing = Math.max(0, progress.total - progress.embedded);
  return {
    id: generation.id,
    state: generation.state,
    providerId: generation.providerId,
    modelId: generation.modelId,
    dimensions: generation.dimensions,
    inputPriceMicros: generation.inputPriceMicros,
    createdAt: generation.createdAt.toISOString(),
    switchedAt: generation.switchedAt?.toISOString() ?? null,
    dropAfter: generation.dropAfter?.toISOString() ?? null,
    storageReady,
    storage,
    passages: { total: progress.total, embedded: progress.embedded },
    perMinute: Math.round(progress.perMinute * 10) / 10,
    etaSeconds:
      missing === 0
        ? 0
        : progress.perMinute > 0
          ? Math.ceil((missing / progress.perMinute) * 60)
          : null,
    failures,
  };
}

/** Everything the Embeddings tab and System health show. Never includes credentials. */
export async function embeddingsStatus(): Promise<EmbeddingsStatus> {
  const store = vectorStore();
  const { settings, current, filling } = await desiredSettings();
  const [health, providers, generations] = await Promise.all([
    store.health(),
    db
      .select({
        id: schema.provider.id,
        label: schema.provider.label,
        kind: schema.provider.kind,
        enabled: schema.provider.enabled,
      })
      .from(schema.provider)
      .orderBy(asc(schema.provider.label)),
    store.listGenerations(),
  ]);
  const currentStatus = current ? await generationStatus(current, true) : null;
  const fillingStatus = filling ? await generationStatus(filling, true) : null;
  const retired = await Promise.all(
    generations
      .filter((generation) => generation.state === 'retired')
      .map((generation) => generationStatus(generation, false)),
  );
  const total =
    currentStatus?.passages.total ?? fillingStatus?.passages.total ?? (await livePassageCount());
  const ready = settings.enabled && currentStatus?.storageReady === true;
  const switchBlocked =
    filling && current?.tableName === LEGACY_EMBEDDING_TABLE && !(await previousReleaseGone())
      ? 'upgrade-in-progress'
      : null;
  return {
    settings,
    pgvector: { state: health.state, version: health.version },
    providers: providers
      .filter((provider) => provider.enabled && providerCanEmbed(provider.kind))
      .map(({ id, label, kind }) => ({ id, label, kind })),
    active: ready,
    storageDimensions: currentStatus?.storageReady ? current!.dimensions : null,
    passages: { total, embedded: ready ? (currentStatus?.passages.embedded ?? 0) : 0 },
    failures: currentStatus?.failures ?? { files: 0, lastError: null },
    generations: { current: currentStatus, filling: fillingStatus, retired, switchBlocked },
    estimate: { passages: total, averageTokens: await averagePassageTokens() },
  };
}

type Check = { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string };

/**
 * The System health row. Meaning-based search is optional, so its absence is
 * fine; a configured model that cannot be used (no pgvector, failing files)
 * is a warning, since keyword search keeps working.
 */
export async function embeddingsHealthCheck(): Promise<Check> {
  const base = { id: 'embeddings', label: 'Meaning-based search' };
  const status = await embeddingsStatus();
  const { settings, pgvector } = status;
  const extension =
    pgvector.state === 'enabled'
      ? `pgvector ${pgvector.version} enabled`
      : pgvector.state === 'available'
        ? 'pgvector installed but not enabled'
        : 'pgvector not installed';
  if (!settings.enabled) {
    return { ...base, status: 'ok', detail: `Off; keyword search only. ${extension}.` };
  }
  if (pgvector.state !== 'enabled') {
    return {
      ...base,
      status: 'warn',
      detail: `An embeddings model is configured but ${extension}, so search is keyword-only. Run CREATE EXTENSION vector.`,
    };
  }
  const current = status.generations.current;
  if (current?.storage === 'mismatch') {
    return {
      ...base,
      status: 'warn',
      detail: `${extension}; the table of the current embeddings (${current.modelId}, ${current.dimensions} dimensions) has another size, so search is keyword-only. Was the model changed on a replica of the previous release during the upgrade? Choose the model again on the Embeddings page.`,
    };
  }
  if (!status.active || !current) {
    return {
      ...base,
      status: 'warn',
      detail: `${extension}; storage for ${current?.modelId ?? settings.modelId ?? 'the model'} is not ready yet. The background job creates it.`,
    };
  }
  let progress = `${status.passages.embedded} of ${status.passages.total} passages embedded with ${current.modelId}`;
  const filling = status.generations.filling;
  if (filling) {
    progress += `; rebuilding for ${filling.modelId}: ${filling.passages.embedded} of ${filling.passages.total}`;
    if (status.generations.switchBlocked) progress += ', switch waits for the upgrade to finish';
  }
  const failing = status.failures.files + (filling?.failures.files ?? 0);
  if (failing > 0) {
    return {
      ...base,
      status: 'warn',
      detail: `${progress}; ${failing} file${failing === 1 ? '' : 's'} failing: ${status.failures.lastError ?? filling?.failures.lastError ?? 'error'}`,
    };
  }
  return { ...base, status: 'ok', detail: `On (${extension}). ${progress}.` };
}
