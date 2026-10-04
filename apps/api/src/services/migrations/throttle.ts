import type postgres from 'postgres';

export interface ThrottleLimits {
  /** Replay lag of any standby above which batches wait; 0 turns the check off. */
  maxReplicationLagMs: number;
  /** Age of the oldest open transaction above which batches wait; 0 turns it off. */
  maxTransactionAgeMs: number;
}

/**
 * Why a background migration should not run its next batch now, or null.
 *
 * - **Replication lag** (`pg_stat_replication.replay_lag` on the primary):
 *   every batch writes WAL a standby must replay, and a standby that falls
 *   behind serves stale reads and loses more on a failover. Reading the lag
 *   columns needs the `pg_monitor` role; without it they are null and the
 *   check sees nothing.
 * - **A long-running transaction** (`pg_stat_activity.xact_start`): while one
 *   is open, vacuum cannot remove the row versions each batch leaves behind,
 *   so a backfill under a long report or `pg_dump` bloats the table it
 *   rewrites. Batches wait until it ends. Only this database's sessions
 *   count: another database's transactions do not hold back vacuum of this
 *   one's tables.
 *
 * Request latency, the design's third signal, is per replica and not visible
 * here; the pause between batches and the batch size bound the extra load.
 */
export async function databasePressure(
  client: postgres.Sql,
  limits: ThrottleLimits,
): Promise<string | null> {
  const [row] = await client<
    [{ lag_ms: number | null; oldest_ms: number | null; oldest_pid: number | null }]
  >`
    select
      (select max(extract(epoch from greatest(replay_lag, write_lag, flush_lag)) * 1000)::float8
         from pg_stat_replication) as lag_ms,
      oldest.age_ms as oldest_ms,
      oldest.pid as oldest_pid
    from (select 1) one
    left join lateral (
      select pid, (extract(epoch from clock_timestamp() - xact_start) * 1000)::float8 as age_ms
      from pg_stat_activity
      where xact_start is not null
        and datname = current_database()
        and pid <> pg_backend_pid()
        and backend_type = 'client backend'
        and state is distinct from 'idle'
      order by xact_start
      limit 1
    ) oldest on true
  `;
  if (!row) return null;
  if (limits.maxReplicationLagMs > 0 && (row.lag_ms ?? 0) > limits.maxReplicationLagMs) {
    return `Replication lag ${duration(row.lag_ms!)} is over ${duration(limits.maxReplicationLagMs)}`;
  }
  if (limits.maxTransactionAgeMs > 0 && (row.oldest_ms ?? 0) > limits.maxTransactionAgeMs) {
    return `A transaction has been open for ${duration(row.oldest_ms!)} (pid ${row.oldest_pid}), over ${duration(limits.maxTransactionAgeMs)}`;
  }
  return null;
}

/** 850 ms, 12 s, 7 min. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 120_000) return `${Math.round(ms / 1_000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
