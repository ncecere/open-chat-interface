import { sql } from '@oci/db';
import { MAX_EMBEDDING_DIMENSIONS, type PgvectorState } from '@oci/shared';
import { db } from '../../db/index.js';

/**
 * pgvector itself: whether the extension is there, and the SQL fragments for
 * its type and operators. Tables of vectors are the vector store's business
 * (services/vector-store/pgvector.ts).
 *
 * The `vector(n)` column needs the pgvector extension, which OCI only detects
 * (an operator enables it: managed databases often restrict extensions), and
 * `n` depends on the embeddings model, so no vector table is in a migration.
 */

export interface PgvectorInfo {
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

export function validDimensions(dimensions: number): boolean {
  return Number.isInteger(dimensions) && dimensions > 0 && dimensions <= MAX_EMBEDDING_DIMENSIONS;
}
