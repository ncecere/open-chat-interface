import { sql } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { isDraining } from '../../lib/drain.js';
import { databaseApplicationName } from '../../lib/instance.js';
import { processRole } from '../../lib/role.js';
import { redisConfigured, sharedRedisClient } from '../chat-streams.js';
import { workerStatus } from '../jobs/workers.js';
import { INTERRUPTED_KEY } from './interrupted.js';
import { registerCollectedGauge } from './metrics.js';

/**
 * Operational gauges read at scrape time, for the alerts in
 * deploy/monitoring/prometheus-rules.yaml (v0.11 design, item 24;
 * docs/dev/slo.md): this replica's role and drain state, its database
 * connections and how long a query waits for one, replication lag, queue
 * depths, Redis, and whether any replica runs background jobs.
 *
 * Every label is a fixed vocabulary (states, queue names, roles). A source
 * that does not answer leaves its samples out of that scrape.
 */

/** Upper bound on the rows a queue-depth count reads: beyond it, the backlog is just large. */
const QUEUE_COUNT_CAP = 100_000;

/** One read of the worker status per scrape, shared by the gauges that need it. */
let workers: { at: number; value: ReturnType<typeof workerStatus> } | null = null;
function cachedWorkerStatus() {
  const now = Date.now();
  if (!workers || now - workers.at > 1_000) workers = { at: now, value: workerStatus() };
  return workers.value;
}

let registered = false;

export function registerOperationalGauges(): void {
  if (registered) return;
  registered = true;

  registerCollectedGauge(
    'oci_process_role',
    'This process’s role (OCI_ROLE): web, worker or all.',
    ['role'],
    async () => [{ labels: { role: processRole() }, value: 1 }],
  );
  registerCollectedGauge(
    'oci_draining',
    '1 while this process drains on shutdown (readiness answers 503), else 0.',
    [],
    async () => [{ value: isDraining() ? 1 : 0 }],
  );

  // --- Database ---------------------------------------------------------
  registerCollectedGauge(
    'oci_database_pool_max',
    'Connections the application pool may open (DATABASE_POOL_MAX).',
    [],
    async () => [{ value: loadEnv().DATABASE_POOL_MAX }],
  );
  registerCollectedGauge(
    'oci_database_probe_seconds',
    'How long a trivial query through the application pool took at scrape time, waiting for a free connection included.',
    [],
    async () => {
      const started = performance.now();
      await db.execute(sql`select 1`);
      return [{ value: (performance.now() - started) / 1000 }];
    },
  );
  registerCollectedGauge(
    'oci_database_connections',
    'This replica’s connections to the primary by state, from pg_stat_activity (its application_name; control connections included, the scrape’s own excluded).',
    ['state'],
    async () => {
      const rows = (await db.execute(sql`
        select coalesce(state, 'unknown') as state, count(*)::int as total
        from pg_stat_activity
        where application_name = ${databaseApplicationName(processRole())}
          and pid <> pg_backend_pid()
        group by 1
      `)) as unknown as Array<{ state: string; total: number }>;
      const byState = new Map(rows.map((row) => [row.state, Number(row.total)]));
      // Always the three states alerts use, so a ratio has both sides.
      for (const state of ['active', 'idle', 'idle in transaction'])
        if (!byState.has(state)) byState.set(state, 0);
      return [...byState].map(([state, value]) => ({ labels: { state }, value }));
    },
  );
  registerCollectedGauge(
    'oci_database_replication_lag_seconds',
    'The largest replay, write or flush lag of a standby (pg_stat_replication on the primary). Absent without standbys or the pg_monitor role.',
    [],
    async () => {
      const [row] = (await db.execute(sql`
        select max(extract(epoch from greatest(replay_lag, write_lag, flush_lag)))::float8 as lag
        from pg_stat_replication
      `)) as unknown as Array<{ lag: number | null }>;
      return row?.lag === null || row?.lag === undefined ? [] : [{ value: Number(row.lag) }];
    },
  );

  // --- Queues -----------------------------------------------------------
  registerCollectedGauge(
    'oci_queue_depth',
    `Work waiting in a database queue (conversation_imports, compaction, usage_rollup_changes), counted up to ${QUEUE_COUNT_CAP}.`,
    ['queue'],
    async () => {
      const [row] = (await db.execute(sql`
        select
          (select count(*) from (select 1 from conversation_import
             where status = 'pending' limit ${QUEUE_COUNT_CAP}) q)::int as imports,
          (select count(*) from (select 1 from conversation_compaction_job
             where status = 'pending' and run_after <= now() limit ${QUEUE_COUNT_CAP}) q)::int as compaction,
          (select count(*) from (select 1 from usage_rollup_change
             limit ${QUEUE_COUNT_CAP}) q)::int as rollups
      `)) as unknown as Array<{ imports: number; compaction: number; rollups: number }>;
      if (!row) return [];
      return [
        { labels: { queue: 'conversation_imports' }, value: Number(row.imports) },
        { labels: { queue: 'compaction' }, value: Number(row.compaction) },
        { labels: { queue: 'usage_rollup_changes' }, value: Number(row.rollups) },
      ];
    },
  );

  // --- Redis and replicas -----------------------------------------------
  registerCollectedGauge(
    'oci_redis_up',
    '1 when Redis answers a PING from this replica, 0 when it is configured but unavailable; absent when not configured.',
    [],
    async () => {
      if (!redisConfigured()) return [];
      const client = await sharedRedisClient();
      if (!client) return [{ value: 0 }];
      try {
        await client.ping();
        return [{ value: 1 }];
      } catch {
        return [{ value: 0 }];
      }
    },
  );
  registerCollectedGauge(
    'oci_background_workers_alive',
    '1 when some replica runs background jobs (this one, a worker or all replica’s heartbeat within 60 s, or a recent job run without Redis), else 0.',
    [],
    async () => [{ value: (await cachedWorkerStatus()).alive ? 1 : 0 }],
  );
  registerCollectedGauge(
    'oci_replicas',
    'Replicas whose heartbeat reached Redis in the last 60 s, by role. Absent without Redis.',
    ['role'],
    async () => {
      const { replicas } = await cachedWorkerStatus();
      if (!replicas) return [];
      return (['web', 'worker', 'all'] as const).map((role) => ({
        labels: { role },
        value: replicas.filter((replica) => replica.role === role).length,
      }));
    },
  );
  registerCollectedGauge(
    'oci_cluster_drain_interrupted_replies_total',
    'Replies saved as interrupted by any replica’s drain limit, counted in Redis (the same on every replica: aggregate with max). Absent without Redis.',
    [],
    async () => {
      const client = await sharedRedisClient();
      if (!client) return [];
      return [{ value: Number((await client.get(INTERRUPTED_KEY)) ?? 0) }];
    },
    'counter',
  );
}
