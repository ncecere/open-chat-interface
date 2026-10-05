import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { type BackgroundMigrationDefinition, backgroundMigrations } from '@oci/db';
import type postgres from 'postgres';
import { loadEnv } from '../../config/env.js';
import { sql as appSql } from '../../db/index.js';
import { isDraining } from '../../lib/drain.js';
import { logger } from '../../lib/logger.js';
import { databasePressure } from './throttle.js';

/**
 * Runs background migrations (v0.11 design, section 1) from the job runner.
 *
 * One worker at a time owns a migration through a lease in its
 * `background_migration` row (claimed with `for update skip locked`, as the
 * compaction queue claims requests). The owner runs one batch per
 * transaction: the transaction locks the row, checks the lease is still its
 * own and the migration still running, runs the batch, and advances the
 * cursor before committing. So a crash, a lost connection or a failover
 * rolls the batch and its cursor back together, and the next owner starts
 * from the last committed cursor: no batch is lost, and none is repeated
 * except one whose commit was lost to asynchronous replication (batches are
 * idempotent for that reason). A worker whose lease ran out finds another
 * owner in the row and stops before writing anything.
 *
 * Between batches it stops when the replica starts draining, when its time
 * budget for this tick is spent (handing the lease back, so any replica's
 * next tick continues), when an administrator pauses the migration, or when
 * the database is under pressure (throttle.ts), which puts the next batch
 * off for a while.
 */

/** A worker that stops renewing its lease (killed, cut off) loses it after this. */
export const LEASE_MS = 2 * 60_000;
/** Failed batches in a row before the migration is marked failed. */
export const MAX_ATTEMPTS = 5;
/** Batches put off by a throttle are tried again after this. */
export const THROTTLE_DELAY_MS = 30_000;
/** How long one job tick keeps running batches; the tick interval is a little longer. */
export const TICK_BUDGET_MS = 25_000;

const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

type Client = postgres.Sql;

export interface MigrationRow {
  name: string;
  table_name: string;
  cursor: string | null;
  batch_size: number;
  pause_ms: number;
  status: string;
  attempts: number;
  lease_owner: string | null;
}

export interface RunOptions {
  client?: Client;
  definitions?: BackgroundMigrationDefinition[];
  /** This worker's lease identity (default: host, pid and a random suffix). */
  owner?: string;
  budgetMs?: number;
  /** Stop between batches when this turns true (default: the replica is draining). */
  shouldStop?: () => boolean;
  /** Why to put the next batch off, or null (default: replication lag and long transactions). */
  throttle?: () => Promise<string | null>;
  batchTimeoutMs?: number;
  lockTimeoutMs?: number;
  leaseMs?: number;
  throttleDelayMs?: number;
  /** Base of the backoff after a failed batch; doubles per attempt. */
  retryDelayMs?: number;
  maxAttempts?: number;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function settings(options: RunOptions) {
  const env = loadEnv();
  const client = options.client ?? appSql;
  return {
    client,
    owner: options.owner ?? OWNER,
    budgetMs: options.budgetMs ?? TICK_BUDGET_MS,
    shouldStop: options.shouldStop ?? isDraining,
    throttle:
      options.throttle ??
      (() =>
        databasePressure(client, {
          maxReplicationLagMs: env.BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS,
          maxTransactionAgeMs: env.BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS,
        })),
    batchTimeoutMs: options.batchTimeoutMs ?? env.BACKGROUND_MIGRATION_BATCH_TIMEOUT_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? env.MIGRATION_LOCK_TIMEOUT_MS,
    leaseMs: options.leaseMs ?? LEASE_MS,
    throttleDelayMs: options.throttleDelayMs ?? THROTTLE_DELAY_MS,
    retryDelayMs: options.retryDelayMs ?? 30_000,
    maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
  };
}

type Settings = ReturnType<typeof settings>;

/**
 * Claims the next migration this release knows that is waiting, or whose
 * owner's lease ran out (or is this worker's own). Paused, failed and
 * finished ones are never claimed.
 */
export async function claimNext(
  client: Client,
  names: string[],
  owner: string,
  leaseMs: number,
): Promise<MigrationRow | null> {
  if (names.length === 0) return null;
  const [row] = await client<MigrationRow[]>`
    update background_migration set
      status = 'running',
      lease_owner = ${owner},
      lease_until = clock_timestamp() + ${`${leaseMs} milliseconds`}::interval,
      started_at = coalesce(started_at, now()),
      updated_at = now()
    where name = (
      select candidate.name from background_migration candidate
      where candidate.name = any(${client.array(names)}::text[])
        and (candidate.status = 'pending'
          or (candidate.status = 'running' and (candidate.lease_until is null
            or candidate.lease_until < clock_timestamp() or candidate.lease_owner = ${owner})))
        and (candidate.next_run_at is null or candidate.next_run_at <= clock_timestamp())
      order by candidate.created_at, candidate.name
      limit 1
      for update skip locked
    )
    returning name, table_name, cursor, batch_size, pause_ms, status, attempts, lease_owner
  `;
  return row ?? null;
}

/** Gives the lease back so any replica's next tick continues straight away. */
async function releaseLease(s: Settings, name: string): Promise<void> {
  await s.client`
    update background_migration set lease_owner = null, lease_until = null, updated_at = now()
    where name = ${name} and lease_owner = ${s.owner}
  `;
}

async function deferThrottled(s: Settings, name: string, reason: string): Promise<void> {
  await s.client`
    update background_migration set
      lease_owner = null, lease_until = null,
      throttled_reason = ${reason}, throttled_at = now(),
      next_run_at = clock_timestamp() + ${`${s.throttleDelayMs} milliseconds`}::interval,
      updated_at = now()
    where name = ${name} and lease_owner = ${s.owner}
  `;
}

/** A failed batch: back off (doubling), and after the last attempt mark it failed. */
async function recordFailure(s: Settings, name: string, error: unknown): Promise<void> {
  const message = errorText(error);
  const [row] = await s.client<{ status: string; attempts: number }[]>`
    update background_migration set
      attempts = attempts + 1,
      last_error = ${message},
      lease_owner = null, lease_until = null,
      status = case when attempts + 1 >= ${s.maxAttempts} then 'failed' else status end,
      next_run_at = clock_timestamp()
        + least(${s.retryDelayMs}::float8 * power(2, attempts), 3600000) * interval '1 millisecond',
      updated_at = now()
    where name = ${name} and lease_owner = ${s.owner}
    returning status, attempts
  `;
  logger.warn(
    { migration: name, attempts: row?.attempts, status: row?.status, error: message },
    row?.status === 'failed'
      ? 'Background migration failed; resume it on System health once the cause is fixed'
      : 'Background migration batch failed; it will be retried',
  );
}

type BatchOutcome =
  | { kind: 'lost' }
  | { kind: 'done'; rows: number }
  | { kind: 'more'; rows: number; pauseMs: number };

/** One batch and its cursor in one transaction, fenced by the lease. */
async function runBatch(
  s: Settings,
  definition: BackgroundMigrationDefinition,
): Promise<BatchOutcome> {
  return s.client.begin(async (tx) => {
    await tx`
      select set_config('lock_timeout', ${String(s.lockTimeoutMs)}, true),
        set_config('statement_timeout', ${String(s.batchTimeoutMs)}, true)
    `;
    const [row] = await tx<MigrationRow[]>`
      select name, table_name, cursor, batch_size, pause_ms, status, attempts, lease_owner
      from background_migration where name = ${definition.name}
      for update
    `;
    if (row?.status !== 'running' || row.lease_owner !== s.owner) {
      return { kind: 'lost' as const };
    }
    const result = await definition.batch(tx, { cursor: row.cursor, batchSize: row.batch_size });
    await tx`
      update background_migration set
        cursor = ${result.cursor},
        rows_processed = rows_processed + ${result.rows},
        batches = batches + 1,
        attempts = 0,
        last_error = null,
        throttled_reason = null,
        throttled_at = null,
        next_run_at = null,
        status = ${result.done ? 'finished' : 'running'},
        finished_at = ${result.done ? tx`now()` : null},
        lease_owner = ${result.done ? null : s.owner},
        lease_until = ${result.done ? null : tx`clock_timestamp() + ${`${s.leaseMs} milliseconds`}::interval`},
        updated_at = now()
      where name = ${definition.name}
    `;
    return result.done
      ? { kind: 'done' as const, rows: result.rows }
      : { kind: 'more' as const, rows: result.rows, pauseMs: row.pause_ms };
  }) as Promise<BatchOutcome>;
}

async function pause(ms: number, s: Settings, deadline: number): Promise<void> {
  const until = Math.min(Date.now() + ms, deadline);
  while (Date.now() < until && !s.shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
  }
}

/**
 * Runs batches of one claimed migration until it finishes, is paused or
 * taken over, the budget runs out or the replica drains (lease handed back),
 * a throttle applies, or a batch fails. Returns the rows processed and
 * whether the tick should stop.
 */
async function runClaimed(
  s: Settings,
  definition: BackgroundMigrationDefinition,
  deadline: number,
): Promise<{ rows: number; stop: boolean }> {
  let rows = 0;
  for (;;) {
    if (s.shouldStop() || Date.now() >= deadline) {
      await releaseLease(s, definition.name);
      return { rows, stop: true };
    }
    const reason = await s.throttle();
    if (reason) {
      await deferThrottled(s, definition.name, reason);
      logger.info({ migration: definition.name, reason }, 'Background migration throttled');
      return { rows, stop: true };
    }
    let outcome: BatchOutcome;
    try {
      outcome = await runBatch(s, definition);
    } catch (error) {
      await recordFailure(s, definition.name, error).catch((failure) =>
        logger.error(
          { migration: definition.name, error: errorText(failure) },
          'Could not record a failed batch',
        ),
      );
      return { rows, stop: true };
    }
    if (outcome.kind === 'lost') return { rows, stop: false };
    rows += outcome.rows;
    if (outcome.kind === 'done') {
      logger.info({ migration: definition.name }, 'Background migration finished');
      return { rows, stop: false };
    }
    await pause(outcome.pauseMs, s, deadline);
  }
}

/**
 * One job tick: claims and runs background migrations this release knows,
 * one at a time, within the time budget. Returns the rows processed.
 */
export async function runBackgroundMigrations(options: RunOptions = {}): Promise<number> {
  const s = settings(options);
  const definitions = options.definitions ?? backgroundMigrations();
  if (definitions.length === 0) return 0;
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const deadline = Date.now() + s.budgetMs;
  let rows = 0;
  while (!s.shouldStop() && Date.now() < deadline) {
    const claimed = await claimNext(s.client, [...byName.keys()], s.owner, s.leaseMs);
    if (!claimed) break;
    const result = await runClaimed(s, byName.get(claimed.name)!, deadline);
    rows += result.rows;
    if (result.stop) break;
  }
  return rows;
}
