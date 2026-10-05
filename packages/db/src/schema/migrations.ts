import { sql } from 'drizzle-orm';
import { bigint, check, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { timestamps } from './_shared.js';
import { pgTable } from './_table.js';

/**
 * Post-deploy steps (v0.11, migration 0039): one row per file in
 * `packages/db/post`, written by `migrate --post` (src/post-migrator.ts). A
 * row without `finishedAt` is a step that failed or was interrupted; the next
 * run repeats it, dropping an index its interrupted build left INVALID.
 */
export const ociPostMigration = pgTable('oci_post_migration', {
  /** The file name without `.sql`, such as `0001_message_created_at_index`. */
  name: text('name').primaryKey(),
  /** SHA-256 of the file when it last ran. */
  checksum: text('checksum').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  ...timestamps(),
});

export const BACKGROUND_MIGRATION_STATUSES = [
  'pending',
  'running',
  'paused',
  'finished',
  'failed',
] as const;
export type BackgroundMigrationStatus = (typeof BACKGROUND_MIGRATION_STATUSES)[number];

/**
 * Background migrations (v0.11, migration 0039): one row per definition in
 * `src/background`, scheduled by `migrate --post` and run in batches by the
 * API's job runner. The worker holding the lease runs one batch per
 * transaction, and that transaction also advances `cursor`, so a crash loses
 * or repeats at most the batch in flight.
 */
export const backgroundMigration = pgTable(
  'background_migration',
  {
    name: text('name').primaryKey(),
    /** The table the migration rewrites, for estimates and progress. */
    tableName: text('table_name').notNull(),
    /** The last key processed; null before the first batch. */
    cursor: text('cursor'),
    batchSize: integer('batch_size').notNull(),
    pauseMs: integer('pause_ms').notNull(),
    status: text('status').$type<BackgroundMigrationStatus>().notNull().default('pending'),
    /** Failed batches in a row; reset by a successful batch. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** Not claimed again before this (backoff after a failure, or a throttle). */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    rowsProcessed: bigint('rows_processed', { mode: 'number' }).notNull().default(0),
    batches: integer('batches').notNull().default(0),
    /** `pg_class.reltuples` of the table when scheduled. */
    estimatedRows: bigint('estimated_rows', { mode: 'number' }),
    /** Why the last batch was put off (replication lag, a long transaction). */
    throttledReason: text('throttled_reason'),
    throttledAt: timestamp('throttled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    check(
      'background_migration_status',
      sql`${t.status} in ('pending', 'running', 'paused', 'finished', 'failed')`,
    ),
    check('background_migration_batch_size', sql`${t.batchSize} between 1 and 100000`),
    check('background_migration_pause_ms', sql`${t.pauseMs} between 0 and 600000`),
  ],
);
