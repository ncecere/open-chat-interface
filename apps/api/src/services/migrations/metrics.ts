import { sql } from '../../db/index.js';
import { registerCollectedGauge } from '../observability/metrics.js';
import { progressOf } from './background-admin.js';

/**
 * Background-migration progress on /metrics (design item 24 lists it among
 * the signals to alert on). Read from the database at scrape time, like the
 * other queue gauges; the labels are migration names (configuration) and a
 * fixed vocabulary of statuses. Batches and failures are also counted by the
 * job runner's `oci_job_runs_total{job="migrations.background"}`.
 */

interface Row {
  name: string;
  status: string;
  cursor: string | null;
  rows_processed: string;
  estimated_rows: string | null;
}

async function rows(): Promise<Row[]> {
  const [exists] = await sql<{ found: boolean }[]>`
    select to_regclass('public.background_migration') is not null as found`;
  if (!exists?.found) return [];
  return sql<Row[]>`
    select name, status, cursor, rows_processed::text, estimated_rows::text
    from background_migration order by name
  `;
}

let registered = false;

export function registerMigrationGauges(): void {
  if (registered) return;
  registered = true;
  registerCollectedGauge(
    'oci_background_migration_rows_processed',
    'Rows processed by each background migration.',
    ['migration'],
    async () =>
      (await rows()).map((row) => ({
        labels: { migration: row.name },
        value: Number(row.rows_processed),
      })),
  );
  registerCollectedGauge(
    'oci_background_migration_progress_ratio',
    'Estimated share of each background migration done, from 0 to 1.',
    ['migration'],
    async () =>
      (await rows()).flatMap((row) => {
        const progress = progressOf({
          status: row.status,
          cursor: row.cursor,
          rowsProcessed: Number(row.rows_processed),
          estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
        });
        return progress === null ? [] : [{ labels: { migration: row.name }, value: progress }];
      }),
  );
  registerCollectedGauge(
    'oci_background_migration_status',
    'Each background migration, 1 for its current status.',
    ['migration', 'status'],
    async () =>
      (await rows()).map((row) => ({
        labels: { migration: row.name, status: row.status },
        value: 1,
      })),
  );
}
