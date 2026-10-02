import { asc, count, desc, eq, schema, sql } from '@oci/db';
import { type EmbeddingsStatus, providerCanEmbed } from '@oci/shared';
import { db } from '../../db/index.js';
import { embeddingModelKey, embeddingsSettings, isActive } from './config.js';
import { EMBEDDING_TABLE, embeddingStorage, pgvectorInfo } from './storage.js';

/** Passages of live project files. */
async function passageTotal(): Promise<number> {
  const [row] = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from project_file_chunk c
    join attachment a on a.id = c.attachment_id
    where a.project_id is not null and a.upload_pending = false and a.deleted_at is null
  `);
  return Number(row?.total ?? 0);
}

async function embeddedTotal(modelKey: string): Promise<number> {
  const [row] = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from ${sql.identifier(EMBEDDING_TABLE)} e
    join attachment a on a.id = e.attachment_id
    where e.model_key = ${modelKey} and a.deleted_at is null
  `);
  return Number(row?.total ?? 0);
}

async function failureSummary(modelKey: string): Promise<EmbeddingsStatus['failures']> {
  const table = schema.projectFileEmbeddingFailure;
  const [total] = await db
    .select({ files: count() })
    .from(table)
    .where(eq(table.modelKey, modelKey));
  if (!total?.files) return { files: 0, lastError: null };
  const [latest] = await db
    .select({ lastError: table.lastError })
    .from(table)
    .where(eq(table.modelKey, modelKey))
    .orderBy(desc(table.updatedAt))
    .limit(1);
  return { files: total.files, lastError: latest?.lastError ?? null };
}

/** Everything the Embeddings tab and System health show. Never includes credentials. */
export async function embeddingsStatus(): Promise<EmbeddingsStatus> {
  const settings = await embeddingsSettings({ fresh: true });
  const [pgvector, storage, providers] = await Promise.all([
    pgvectorInfo(),
    embeddingStorage(),
    db
      .select({
        id: schema.provider.id,
        label: schema.provider.label,
        kind: schema.provider.kind,
        enabled: schema.provider.enabled,
      })
      .from(schema.provider)
      .orderBy(asc(schema.provider.label)),
  ]);
  const storageDimensions = storage?.dimensions ?? null;
  const ready =
    isActive(settings) && storageDimensions !== null && storageDimensions === settings.dimensions;
  const modelKey = isActive(settings) ? embeddingModelKey(settings) : null;
  const total = await passageTotal();
  return {
    settings,
    pgvector: { state: pgvector.state, version: pgvector.version },
    providers: providers
      .filter((provider) => provider.enabled && providerCanEmbed(provider.kind))
      .map(({ id, label, kind }) => ({ id, label, kind })),
    active: ready,
    storageDimensions,
    passages: { total, embedded: ready && modelKey ? await embeddedTotal(modelKey) : 0 },
    failures: modelKey ? await failureSummary(modelKey) : { files: 0, lastError: null },
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
  if (!status.active) {
    return {
      ...base,
      status: 'warn',
      detail: `${extension}; storage for ${settings.modelId ?? 'the model'} is not ready yet. The background job creates it.`,
    };
  }
  const progress = `${status.passages.embedded} of ${status.passages.total} passages embedded with ${settings.modelId}`;
  if (status.failures.files > 0) {
    return {
      ...base,
      status: 'warn',
      detail: `${progress}; ${status.failures.files} file${status.failures.files === 1 ? '' : 's'} failing: ${status.failures.lastError ?? 'error'}`,
    };
  }
  return { ...base, status: 'ok', detail: `On (${extension}). ${progress}.` };
}
