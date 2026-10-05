import { createDatabase, type Database } from '@oci/db';
import { loadEnv } from '../config/env.js';
import { isConnectionError } from '../lib/db-connection.js';
import { databaseApplicationName } from '../lib/instance.js';
import { logger } from '../lib/logger.js';
import { processRole } from '../lib/role.js';
import { registerCollectedGauge } from '../services/observability/metrics.js';
import { sql as primarySql } from './index.js';
import { scopedDatabase, withDatabase } from './routing.js';

/**
 * Read routing (v0.11 design, section 11).
 *
 * With `READ_DATABASE_URL` set, heavy administrative reads that tolerate a
 * second of staleness run on a streaming replica instead of the primary. They
 * are chosen at the call site, never by default, and never for a person's own
 * data (which they may just have written):
 *
 * | Call site | Why it may be stale |
 * | --- | --- |
 * | `GET /api/admin/overview` (counts, activity, storage) | Totals across the instance |
 * | `GET /api/admin/usage/*` (overview, spend, limits, storage) | Aggregates over days; rollups already trail by up to 30 s |
 *
 * **Bounded staleness.** While routed reads happen, the primary's WAL
 * position is sampled every 250 ms (`pg_current_wal_lsn()`) and the replica's
 * replay position checked against the sample taken `READ_DATABASE_MAX_LAG_MS`
 * earlier. The replica is used only while it has replayed at least that much,
 * so what it answers is never older than the bound (plus one sample). When
 * it is behind, unreachable, or not checked recently, reads go to the primary;
 * a read that fails on the replica with a connection error or a recovery
 * conflict is run again on the primary. Sampling stops a minute after the
 * last routed read.
 *
 * Point `READ_DATABASE_URL` at one replica (or a pooler in front of one). With
 * a load balancer over several, each check reaches one of them, so the bound
 * holds only if every replica behind it keeps up equally.
 */
export const readRouting = {
  sampleMs: 250,
  /** A check older than this is not trusted. */
  staleCheckMs: 2_000,
  /** After a failure on the replica, how long reads stay on the primary. */
  backoffMs: 5_000,
  idleStopMs: 60_000,
};

interface Sample {
  at: number;
  lsn: bigint;
}

interface ReplicaState {
  pool: ReturnType<typeof createDatabase>;
  samples: Sample[];
  /** The newest check: whether the replica was within the bound, and when. */
  check: { fresh: boolean; at: number } | null;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  lastUse: number;
  failedUntil: number;
  routed: { replica: number; primary: number };
}

let state: ReplicaState | null = null;

/** `X/Y` (hex) into one comparable number. */
export function parseLsn(text: string): bigint {
  const [high, low] = text.split('/');
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

function replicaState(url: string): ReplicaState {
  if (state) return state;
  const env = loadEnv();
  state = {
    pool: createDatabase(url, {
      max: env.READ_DATABASE_POOL_MAX ?? 5,
      applicationName: databaseApplicationName(processRole()),
    }),
    samples: [],
    check: null,
    timer: null,
    ticking: false,
    lastUse: 0,
    failedUntil: 0,
    routed: { replica: 0, primary: 0 },
  };
  registerCollectedGauge(
    'oci_read_replica_in_use',
    'Whether heavy administrative reads go to READ_DATABASE_URL (1) or the primary (0) right now.',
    [],
    async () => [{ value: usable(Date.now()) ? 1 : 0 }],
  );
  return state;
}

/** Whether the replica may answer now. */
function usable(now: number): boolean {
  if (!state?.check || now < state.failedUntil) return false;
  return state.check.fresh && now - state.check.at <= readRouting.staleCheckMs;
}

async function tick(current: ReplicaState, maxLagMs: number) {
  if (current.ticking) return;
  current.ticking = true;
  const now = Date.now();
  try {
    const [primary, replica] = await Promise.allSettled([
      primarySql<{ lsn: string }[]>`select pg_current_wal_lsn()::text as lsn`,
      current.pool.sql<{ lsn: string | null }[]>`
        select (case when pg_is_in_recovery() then pg_last_wal_replay_lsn()
                     else pg_current_wal_lsn() end)::text as lsn`,
    ]);
    if (primary.status === 'fulfilled' && primary.value[0]) {
      current.samples.push({ at: now, lsn: parseLsn(primary.value[0].lsn) });
      const keep = now - maxLagMs - 5_000;
      while (current.samples.length > 1 && current.samples[0]!.at < keep) current.samples.shift();
    }
    // The newest primary position at least the bound old.
    const target = current.samples.filter((sample) => sample.at <= now - maxLagMs).at(-1);
    const replayed =
      replica.status === 'fulfilled' && replica.value[0]?.lsn
        ? parseLsn(replica.value[0].lsn)
        : null;
    const fresh = Boolean(
      primary.status === 'fulfilled' && target && replayed !== null && replayed >= target.lsn,
    );
    if (current.check && current.check.fresh !== fresh)
      logger.info(
        { fresh },
        fresh
          ? 'Read replica caught up: heavy administrative reads use it again'
          : 'Read replica behind or unreachable: heavy administrative reads use the primary',
      );
    current.check = { fresh, at: Date.now() };
  } finally {
    current.ticking = false;
  }
  if (Date.now() - current.lastUse > readRouting.idleStopMs) stopSampling();
}

function startSampling(current: ReplicaState, maxLagMs: number) {
  if (current.timer) return;
  void tick(current, maxLagMs);
  current.timer = setInterval(() => void tick(current, maxLagMs), readRouting.sampleMs);
  current.timer.unref();
}

function stopSampling() {
  if (!state?.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  state.samples = [];
  state.check = null;
}

/** A recovery conflict cancels a long query on a standby (SQLSTATE 40001 there). */
function isReplicaOnlyFailure(error: unknown): boolean {
  if (isConnectionError(error)) return true;
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === '40001') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs a read-only piece of work with `db` answering from the read replica
 * when one is configured and within the staleness bound; otherwise (and if
 * the replica fails it) on the primary. `work` must only read: the replica
 * refuses writes.
 */
export async function onReadReplica<T>(work: () => Promise<T>): Promise<T> {
  const env = loadEnv();
  const url = env.READ_DATABASE_URL;
  if (!url || scopedDatabase()) return work();
  const current = replicaState(url);
  current.lastUse = Date.now();
  startSampling(current, env.READ_DATABASE_MAX_LAG_MS ?? 1_000);
  if (!usable(Date.now())) {
    current.routed.primary++;
    return work();
  }
  current.routed.replica++;
  try {
    return await withDatabase(current.pool.db, work);
  } catch (error) {
    if (!isReplicaOnlyFailure(error)) throw error;
    current.failedUntil = Date.now() + readRouting.backoffMs;
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'A read on the read replica failed; running it on the primary',
    );
    current.routed.primary++;
    return work();
  }
}

/** Where routed reads went, for System health and tests. Null without READ_DATABASE_URL. */
export function readRoutingStatus() {
  if (!loadEnv().READ_DATABASE_URL) return null;
  return {
    inUse: usable(Date.now()),
    checkedAt: state?.check ? new Date(state.check.at).toISOString() : null,
    routed: { ...(state?.routed ?? { replica: 0, primary: 0 }) },
  };
}

/** Closes the replica pool (shutdown and tests). */
export async function closeReadReplica(): Promise<void> {
  const current = state;
  stopSampling();
  state = null;
  await current?.pool.sql.end({ timeout: 5 });
}

/** The replica's database, for tests. */
export function readReplicaDatabase(): Database | null {
  return state?.pool.db ?? null;
}
