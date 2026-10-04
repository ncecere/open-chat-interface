import { type BackgroundMigrationDefinition, backgroundMigrations } from '@oci/db';
import type { BackgroundMigrationSummary } from '@oci/shared';
import type postgres from 'postgres';
// No import of db/index.js: the upgrade-check script uses this module with
// only DATABASE_URL set, and every caller passes its client.
import { conflict, notFound } from '../../lib/errors.js';

interface Row {
  name: string;
  table_name: string;
  cursor: string | null;
  batch_size: number;
  pause_ms: number;
  status: BackgroundMigrationSummary['status'];
  attempts: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  next_run_at: Date | null;
  rows_processed: string | number;
  batches: number;
  estimated_rows: string | number | null;
  current_rows: string | number | null;
  table_bytes: string | number | null;
  throttled_reason: string | null;
  throttled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

const UUID_PREFIX = /^[0-9a-f]{8}-/i;

/**
 * How far a migration has got, from 0 to 1, or null when it cannot be told.
 * Keys that are UUIDs (every OCI table's `id`) are uniformly spread, so the
 * cursor's position in the key space is the share of rows already behind it;
 * otherwise rows processed against the table's estimated rows, held below 1
 * until the migration says it has finished.
 */
export function progressOf(input: {
  status: string;
  cursor: string | null;
  rowsProcessed: number;
  estimatedRows: number | null;
}): number | null {
  if (input.status === 'finished') return 1;
  if (input.cursor && UUID_PREFIX.test(input.cursor)) {
    return Math.min(0.999, Number.parseInt(input.cursor.slice(0, 8), 16) / 2 ** 32);
  }
  if (input.cursor === null && input.rowsProcessed === 0) return 0;
  if (input.estimatedRows && input.estimatedRows > 0) {
    return Math.min(0.99, input.rowsProcessed / input.estimatedRows);
  }
  return null;
}

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
const num = (value: string | number | null) => (value === null ? null : Number(value));

function summary(
  row: Row | undefined,
  definition: BackgroundMigrationDefinition | undefined,
  name: string,
): BackgroundMigrationSummary {
  if (!row) {
    return {
      name,
      description: definition?.description ?? null,
      release: definition?.release ?? null,
      table: definition?.table ?? '',
      bundled: true,
      status: 'not_scheduled',
      cursor: null,
      batchSize: definition?.batchSize ?? 0,
      pauseMs: definition?.pauseMs ?? 0,
      rowsProcessed: 0,
      batches: 0,
      estimatedRows: null,
      tableBytes: null,
      progress: null,
      attempts: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      nextRunAt: null,
      throttledReason: null,
      throttledAt: null,
      startedAt: null,
      finishedAt: null,
    };
  }
  // The estimate made when it was scheduled, or the table's current one if larger.
  const estimate = Math.max(num(row.estimated_rows) ?? 0, num(row.current_rows) ?? 0) || null;
  const rowsProcessed = Number(row.rows_processed);
  return {
    name: row.name,
    description: definition?.description ?? null,
    release: definition?.release ?? null,
    table: row.table_name,
    bundled: definition !== undefined,
    status: row.status,
    cursor: row.cursor,
    batchSize: row.batch_size,
    pauseMs: row.pause_ms,
    rowsProcessed,
    batches: row.batches,
    estimatedRows: estimate,
    tableBytes: num(row.table_bytes),
    progress: progressOf({
      status: row.status,
      cursor: row.cursor,
      rowsProcessed,
      estimatedRows: estimate,
    }),
    attempts: row.attempts,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    leaseUntil: iso(row.lease_until),
    nextRunAt: iso(row.next_run_at),
    throttledReason: row.throttled_reason,
    throttledAt: iso(row.throttled_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

const SELECT = (client: postgres.Sql) => client`
  select b.*,
    case when c.reltuples < 0 then null else c.reltuples::bigint end as current_rows,
    case when c.oid is null then null else pg_total_relation_size(c.oid) end as table_bytes
  from background_migration b
  left join pg_class c on c.oid = to_regclass(b.table_name)
`;

/**
 * Every background migration: those scheduled in the database (including any
 * a newer release scheduled, marked not bundled) and those this release
 * bundles but has not scheduled yet (`migrate --post` schedules them).
 */
export async function listBackgroundMigrations(
  client: postgres.Sql,
  definitions: BackgroundMigrationDefinition[] = backgroundMigrations(),
): Promise<BackgroundMigrationSummary[]> {
  const [exists] = await client<{ found: boolean }[]>`
    select to_regclass('public.background_migration') is not null as found`;
  const rows = exists?.found
    ? ((await client`${SELECT(client)} order by b.created_at, b.name`) as unknown as Row[])
    : [];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const seen = new Set(rows.map((row) => row.name));
  return [
    ...rows.map((row) => summary(row, byName.get(row.name), row.name)),
    ...definitions
      .filter((definition) => !seen.has(definition.name))
      .map((definition) => summary(undefined, definition, definition.name)),
  ];
}

async function one(client: postgres.Sql, name: string): Promise<BackgroundMigrationSummary> {
  const rows = (await client`${SELECT(client)} where b.name = ${name}`) as unknown as Row[];
  const definition = backgroundMigrations().find((candidate) => candidate.name === name);
  return summary(rows[0], definition, name);
}

async function existing(client: postgres.Sql, name: string): Promise<string> {
  const [row] = await client<{ status: string }[]>`
    select status from background_migration where name = ${name}`;
  if (!row) throw notFound('No background migration by that name is scheduled');
  return row.status;
}

/**
 * Stops a migration between batches: the batch in progress (if any) commits,
 * and no worker claims it again until it is resumed.
 */
export async function pauseBackgroundMigration(
  client: postgres.Sql,
  name: string,
): Promise<BackgroundMigrationSummary> {
  const status = await existing(client, name);
  const rows = await client`
    update background_migration set status = 'paused', lease_owner = null, lease_until = null,
      updated_at = now()
    where name = ${name} and status in ('pending', 'running', 'failed')
    returning name
  `;
  if (rows.length === 0) {
    throw conflict(`A ${status} background migration cannot be paused`);
  }
  return one(client, name);
}

/** Resumes a paused or failed migration from its cursor, with its failure count reset. */
export async function resumeBackgroundMigration(
  client: postgres.Sql,
  name: string,
): Promise<BackgroundMigrationSummary> {
  const status = await existing(client, name);
  const rows = await client`
    update background_migration set
      status = case when batches = 0 then 'pending' else 'running' end,
      attempts = 0, next_run_at = null, throttled_reason = null, updated_at = now()
    where name = ${name} and status in ('paused', 'failed')
    returning name
  `;
  if (rows.length === 0) {
    throw conflict(`A ${status} background migration cannot be resumed`);
  }
  return one(client, name);
}

/** Changes the batch size or pause; the next batch uses them. */
export async function updateBackgroundMigration(
  client: postgres.Sql,
  name: string,
  patch: { batchSize?: number; pauseMs?: number },
): Promise<BackgroundMigrationSummary> {
  await existing(client, name);
  await client`
    update background_migration set
      batch_size = coalesce(${patch.batchSize ?? null}::integer, batch_size),
      pause_ms = coalesce(${patch.pauseMs ?? null}::integer, pause_ms),
      updated_at = now()
    where name = ${name}
  `;
  return one(client, name);
}
