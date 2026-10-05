import { foldUsageRollupChanges, USAGE_ROLLUP_BACKFILL } from '../usage-rollups.js';
import type { BackgroundMigrationDefinition } from './types.js';

/**
 * Adds the usage events written before migration 0040 to the usage rollups
 * (docs/dev/database.md, "Usage rollups"), the first real background
 * migration.
 *
 * Each batch marks the next events in key order `in_rollup`. The statement
 * triggers on `usage_event` then write their amounts to the change log, in
 * this batch's transaction, and the batch folds what is waiting there (the
 * fold job does too; whichever holds the fold lock does it). Idempotent: an
 * event already marked (by this migration or by any write since 0040) is
 * skipped, and a marked event's later changes are differences, so nothing is
 * counted twice, however often a batch runs.
 *
 * Until it finishes, readers use the events themselves
 * (`isBackgroundMigrationDone('0.11.usage-rollups')`), so an upgrade never
 * shows partial totals.
 */
export const usageRollupBackfill: BackgroundMigrationDefinition = {
  name: USAGE_ROLLUP_BACKFILL,
  release: '0.11.0',
  table: 'public.usage_event',
  description:
    'Adds usage recorded before 0.11 to the hourly usage rollups that reports and budgets read.',
  batchSize: 2_000,
  pauseMs: 100,
  async batch(sql, { cursor, batchSize }) {
    const [row] = await sql<[{ rows: number; examined: number; last: string | null }]>`
      with batch as (
        select id from usage_event
        where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
        order by id
        limit ${batchSize}
      ),
      marked as (
        update usage_event e set in_rollup = true
        from batch where e.id = batch.id and e.in_rollup is not true
        returning e.id
      )
      select (select count(*) from marked)::integer as rows,
             (select count(*) from batch)::integer as examined,
             (select id from batch order by id desc limit 1) as last
    `;
    // Keep the change log short while the backfill fills it; the fold job
    // does the rest. Bounded, so the batch stays well under its timeout.
    await foldUsageRollupChanges(sql, batchSize * 2);
    const examined = row?.examined ?? 0;
    return { cursor: row?.last ?? cursor, rows: examined, done: examined < batchSize };
  },
};
