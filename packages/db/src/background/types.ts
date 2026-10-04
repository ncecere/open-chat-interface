import type postgres from 'postgres';

/** The transaction a batch runs in; the runner commits it with the cursor. */
export type BatchTransaction = postgres.TransactionSql;

export interface BackgroundBatchInput {
  /** The last key the previous batch processed; null for the first batch. */
  cursor: string | null;
  /** Rows to process at most; an administrator can change it while it runs. */
  batchSize: number;
}

export interface BackgroundBatchResult {
  /** The last key this batch processed (the next batch starts after it). */
  cursor: string | null;
  /** Rows the batch changed or examined, for progress. */
  rows: number;
  /** True when nothing is left after this batch. */
  done: boolean;
}

/**
 * A background migration (v0.11 design, section 1): a backfill or rewrite of
 * existing rows, run in batches by the API's job runner while OCI serves.
 *
 * Rules (docs/dev/database.md, "Background migrations"):
 *
 * - `batch` is called inside a transaction that the runner commits together
 *   with the new cursor. It must do all its writes through `sql` (the
 *   transaction), never through another connection, so a crash leaves both
 *   the rows and the cursor as they were.
 * - It must be idempotent: a batch whose commit was lost to a failover is
 *   run again, on rows that may already be converted.
 * - It walks the table in key order (`where key > cursor order by key limit
 *   batchSize`), compares keys in SQL (never in JavaScript, whose string
 *   order differs from the column's collation), and returns the last key.
 * - Rows written after the migration starts must not need it: release N's
 *   own code writes them correctly. That is why `migrate --post` schedules
 *   background migrations, after every replica runs release N.
 */
export interface BackgroundMigrationDefinition {
  /** Unique and permanent, such as `0.12.message-search-vector`. */
  name: string;
  /** The release that introduced it, or `test` for test-only definitions. */
  release: string;
  /** Schema-qualified table it rewrites, for estimates and progress. */
  table: string;
  /** One sentence for administrators, shown on System health. */
  description: string;
  /** Default rows per batch (1 to 100,000). */
  batchSize: number;
  /** Default pause between batches, in milliseconds. */
  pauseMs: number;
  batch: (sql: BatchTransaction, input: BackgroundBatchInput) => Promise<BackgroundBatchResult>;
}
