import { sql } from '@oci/db';
import { MAX_EMBEDDING_DIMENSIONS, type PgvectorState } from '@oci/shared';
import { db } from '../../db/index.js';

/**
 * Where embeddings are stored, and whether they can be.
 *
 * The `vector(n)` column needs the pgvector extension, which OCI only detects
 * (an operator enables it: managed databases often restrict extensions), and
 * `n` depends on the embeddings model. So the table is not in any migration:
 * it is created here, at runtime, once both are known, and re-created when the
 * model's dimensions change.
 */
export const EMBEDDING_TABLE = 'project_file_embedding';
const STORAGE_LOCK = 'oci:embeddings:storage';

interface PgvectorInfo {
  state: PgvectorState;
  version: string | null;
  /** Schema the extension was created in; its type and operators are qualified with it. */
  schema: string | null;
}

/** Reads the catalog only: never creates the extension. */
export async function pgvectorInfo(): Promise<PgvectorInfo> {
  const [row] = await db.execute<{
    version: string | null;
    schema: string | null;
    available: boolean;
  }>(sql`
    select e.extversion as version,
           n.nspname as schema,
           exists (select 1 from pg_available_extensions where name = 'vector') as available
    from (select 1) as one
    left join pg_extension e on e.extname = 'vector'
    left join pg_namespace n on n.oid = e.extnamespace
  `);
  if (row?.version && row.schema) {
    return { state: 'enabled', version: row.version, schema: row.schema };
  }
  return { state: row?.available ? 'available' : 'not-installed', version: null, schema: null };
}

interface EmbeddingStorage {
  /** Schema of the pgvector extension. */
  schema: string;
  /** Dimensions of the stored vector column, or null when the table does not exist yet. */
  dimensions: number | null;
}

/** The dimensions of the embedding column, or null when the table does not exist. */
async function tableDimensions(executor: Pick<typeof db, 'execute'>): Promise<number | null> {
  const [row] = await executor.execute<{ dimensions: number | null }>(sql`
    select a.atttypmod as dimensions
    from pg_attribute a
    where a.attrelid = to_regclass(${EMBEDDING_TABLE})
      and a.attname = 'embedding'
      and not a.attisdropped
  `);
  return row?.dimensions == null ? null : Number(row.dimensions);
}

/** Null when pgvector is not enabled, so nothing can be stored or searched. */
export async function embeddingStorage(): Promise<EmbeddingStorage | null> {
  const info = await pgvectorInfo();
  if (info.state !== 'enabled' || !info.schema) return null;
  return { schema: info.schema, dimensions: await tableDimensions(db) };
}

/** The pgvector type, qualified with the extension's schema. */
export function vectorType(schema: string, dimensions?: number) {
  const name = sql`${sql.identifier(schema)}.vector`;
  return dimensions === undefined ? name : sql`${name}(${sql.raw(String(dimensions))})`;
}

/** pgvector's cosine-distance operator, qualified with the extension's schema. */
export function cosineDistance(schema: string) {
  return sql`operator(${sql.identifier(schema)}.<=>)`;
}

/** A vector as pgvector's text form; every element must be a finite number. */
export function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function validDimensions(dimensions: number): boolean {
  return Number.isInteger(dimensions) && dimensions > 0 && dimensions <= MAX_EMBEDDING_DIMENSIONS;
}

/**
 * Makes sure the embedding table exists with a `dimensions`-wide vector
 * column. Idempotent and safe to run concurrently: a transaction-scoped
 * advisory lock serialises callers, and each re-checks under the lock. A
 * table of other dimensions is dropped and re-created empty (its vectors
 * belong to a previous model and could never be compared with the new one);
 * the background job then embeds every passage again.
 *
 * Each embedding belongs to one passage and goes with it (and so with its
 * file, project and owner) through ON DELETE CASCADE.
 */
export async function ensureEmbeddingTable(
  dimensions: number,
): Promise<'created' | 'recreated' | 'ready'> {
  if (!validDimensions(dimensions)) throw new RangeError('Invalid embedding dimensions');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${STORAGE_LOCK}))`);
    const [extension] = await tx.execute<{ schema: string }>(sql`
      select n.nspname as schema
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'vector'
    `);
    if (!extension) throw new Error('The pgvector extension is not enabled');
    const current = await tableDimensions(tx);
    if (current === dimensions) return 'ready';
    const table = sql.identifier(EMBEDDING_TABLE);
    if (current !== null) await tx.execute(sql`drop table ${table}`);
    await tx.execute(sql`
      create table ${table} (
        attachment_id text not null,
        ordinal integer not null,
        model_key text not null,
        embedding ${vectorType(extension.schema, dimensions)} not null,
        embedded_at timestamp with time zone not null default now(),
        constraint project_file_embedding_pk primary key (attachment_id, ordinal),
        constraint project_file_embedding_chunk_fk foreign key (attachment_id, ordinal)
          references project_file_chunk (attachment_id, ordinal) on delete cascade
      )
    `);
    return current === null ? 'created' : 'recreated';
  });
}
