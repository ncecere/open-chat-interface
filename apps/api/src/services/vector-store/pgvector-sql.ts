import { schema, sql } from '@oci/db';
import {
  type EmbeddingConfig,
  type Generation,
  type TransactionExecutor,
  type VectorScope,
  VectorScopeError,
} from './types.js';

/** The table the previous release uses, kept as generation 1's. */
export const LEGACY_EMBEDDING_TABLE = 'project_file_embedding';
const TABLE_NAME = /^project_file_embedding(_g[1-9][0-9]*)?$/;
/** The lock v0.10's `ensureEmbeddingTable` takes, so both releases serialise table changes. */
export const STORAGE_LOCK = 'oci:embeddings:storage';
export const GENERATION_LOCK = 'oci:embeddings:generations';
/** Window for the fill rate shown to administrators. */
export const RATE_WINDOW_MINUTES = 10;
/**
 * Creating or dropping a vector table locks `project_file_chunk` briefly (its
 * foreign key). Never wait long for that: a busy moment is retried next tick.
 */
export const DDL_LOCK_TIMEOUT = '2s';
export const MAX_ERROR_CHARS = 500;
const MINUTE_MS = 60_000;

/** Backoff after a file's n-th failure: 5, 10, 20 ... minutes, at most six hours. */
export function failureBackoffMs(failures: number): number {
  return Math.min(5 * MINUTE_MS * 2 ** Math.max(0, failures - 1), 6 * 60 * MINUTE_MS);
}

export function generationTableName(id: number): string {
  return id === 1 ? LEGACY_EMBEDDING_TABLE : `${LEGACY_EMBEDDING_TABLE}_g${id}`;
}

/** Identifies the vectors one configuration produces; see `embeddingModelKey`. */
export function configKey(config: Pick<EmbeddingConfig, 'providerId' | 'modelId' | 'dimensions'>) {
  return `${config.providerId}/${config.modelId}/${config.dimensions}`;
}

/** The table as an identifier, after checking it is one of ours (never free text). */
export function vectorTable(name: string) {
  if (!TABLE_NAME.test(name)) throw new Error(`Not an embedding table: ${name}`);
  return sql.identifier(name);
}

/** A bound text[] literal: one parameter per element, never spliced as SQL. */
export function textArray(values: string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** Project files that count: in a project, uploaded, not in the trash. */
export const LIVE_FILE = sql`a.project_id is not null and a.upload_pending = false and a.deleted_at is null`;

export const G = schema.embeddingGeneration;
export const F = schema.embeddingGenerationFailure;

export function toGeneration(row: typeof G.$inferSelect): Generation {
  const { updatedAt: _updatedAt, ...generation } = row;
  return { ...generation, inputPriceMicros: row.inputPriceMicros ?? null };
}

function assertScope(scope: VectorScope): void {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!scope || !text(scope.personId) || !text(scope.projectId)) {
    throw new VectorScopeError('A vector search needs a person and a project');
  }
  if (
    scope.fileIds !== undefined &&
    (!Array.isArray(scope.fileIds) || !scope.fileIds.every((id) => typeof id === 'string'))
  ) {
    throw new VectorScopeError('File ids must be a list of ids');
  }
}

/** The person-and-project filter, on `e` (vectors) joined to `a` (attachment). */
export function scopeFilter(scope: VectorScope) {
  assertScope(scope);
  return sql`a.user_id = ${scope.personId}
    and a.project_id = ${scope.projectId}
    and a.upload_pending = false
    and a.deleted_at is null
    ${scope.fileIds ? sql`and e.attachment_id = any(${textArray(scope.fileIds)})` : sql``}`;
}

interface StorageInfo {
  /** Schema of the pgvector extension, or null when it is not enabled. */
  schema: string | null;
  /** Size of the table's vector column, or null when the table does not exist. */
  dimensions: number | null;
}

export async function storageInfo(
  executor: TransactionExecutor,
  tableName: string,
): Promise<StorageInfo> {
  const [row] = await executor.execute<{ schema: string | null; dimensions: number | null }>(sql`
    select n.nspname as schema,
           (select a.atttypmod from pg_attribute a
            where a.attrelid = to_regclass(${tableName})
              and a.attname = 'embedding' and not a.attisdropped) as dimensions
    from (select 1) as one
    left join pg_extension e on e.extname = 'vector'
    left join pg_namespace n on n.oid = e.extnamespace
  `);
  return {
    schema: row?.schema ?? null,
    dimensions: row?.dimensions == null ? null : Number(row.dimensions),
  };
}

export async function lock(executor: TransactionExecutor, name: string) {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${name}))`);
}
