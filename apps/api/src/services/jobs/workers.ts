import { hostname } from 'node:os';
import { desc, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { instanceId } from '../../lib/instance.js';
import { logger } from '../../lib/logger.js';
import { type ProcessRole, processRole, runsBackgroundJobs } from '../../lib/role.js';
import { APP_VERSION } from '../../version.js';
import { sharedRedis } from '../chat-streams.js';

/**
 * Which replicas are running, and whether any of them runs background jobs
 * (v0.11 design, item 14).
 *
 * A deployment of `web` replicas only (OCI_ROLE=web) serves every request but
 * runs no background work: imports wait, embeddings and summaries are never
 * made, webhooks are never sent, retention and backups stop. Nothing fails
 * loudly, so this is what notices: every replica writes a small heartbeat to
 * Redis, and System health (and each `web` replica's log) warns when no
 * `worker` or `all` replica has written one recently.
 *
 * Without Redis (supported for a single replica), the interrupted-reply sweep
 * stands in for a heartbeat: every job-running replica tries it every 15 s and
 * the one that wins records a run, so a recent run of it means jobs run.
 */
export const replicaHeartbeat = {
  intervalMs: 15_000,
  /** A replica not heard from for this long is treated as gone. */
  staleMs: 60_000,
};

/** The every-15-seconds job whose recorded runs show that some replica runs jobs. */
export const SWEEP_JOB = 'chat.recover-interrupted-replies';

// One hash tag for the list and every entry: they are written in one MULTI
// and read with one MGET, which Redis Cluster allows only within a slot.
const REPLICAS_KEY = 'oci:{replicas}:list';
const replicaKey = (id: string) => `oci:{replicas}:replica:${id}`;
const startedAt = new Date().toISOString();

export interface ReplicaInfo {
  id: string;
  role: ProcessRole;
  host: string;
  version: string;
  startedAt: string;
  seenAt: string;
}

async function beat(role: ProcessRole): Promise<void> {
  const redis = await sharedRedis();
  if (!redis) return;
  const now = Date.now();
  const info: ReplicaInfo = {
    id: instanceId,
    role,
    host: hostname(),
    version: APP_VERSION,
    startedAt,
    seenAt: new Date(now).toISOString(),
  };
  await redis
    .multi()
    .zadd(REPLICAS_KEY, now, instanceId)
    .set(replicaKey(instanceId), JSON.stringify(info), 'PX', replicaHeartbeat.staleMs)
    // Replicas that stopped without saying so drop out after a day.
    .zremrangebyscore(REPLICAS_KEY, '-inf', now - 24 * 60 * 60 * 1000)
    .exec();
}

/**
 * Starts this replica's heartbeat. The returned function stops it and removes
 * the replica from the list at once (a replica shutting down is not a worker
 * any more, even while it drains).
 */
export function startReplicaHeartbeat(role: ProcessRole = processRole()): () => Promise<void> {
  const tick = () =>
    beat(role).catch((error: unknown) =>
      logger.debug({ err: String(error) }, 'Replica heartbeat failed'),
    );
  void tick();
  const timer = setInterval(() => void tick(), replicaHeartbeat.intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    const redis = await sharedRedis().catch(() => null);
    await redis
      ?.multi()
      .zrem(REPLICAS_KEY, instanceId)
      .del(replicaKey(instanceId))
      .exec()
      .catch(() => undefined);
  };
}

/** Replicas heard from within `staleMs`, or null without Redis. */
export async function liveReplicas(): Promise<ReplicaInfo[] | null> {
  const redis = await sharedRedis();
  if (!redis) return null;
  const ids = await redis.zrangebyscore(
    REPLICAS_KEY,
    Date.now() - replicaHeartbeat.staleMs,
    '+inf',
  );
  if (ids.length === 0) return [];
  const values = await redis.mget(ids.map(replicaKey));
  return values
    .flatMap((value) => {
      if (!value) return [];
      try {
        return [JSON.parse(value) as ReplicaInfo];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.role.localeCompare(b.role) || a.host.localeCompare(b.host));
}

async function lastSweepAt(): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: schema.jobRun.startedAt })
    .from(schema.jobRun)
    .where(eq(schema.jobRun.jobName, SWEEP_JOB))
    .orderBy(desc(schema.jobRun.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export interface WorkerStatus {
  /** Some replica runs background jobs. */
  alive: boolean;
  /** How that was decided. */
  evidence: 'this-replica' | 'heartbeat' | 'job-runs' | 'none';
  /** Replicas heard from recently; null without Redis. */
  replicas: ReplicaInfo[] | null;
  /** The most recent run of the 15-second sweep, from any replica. */
  lastJobRunAt: Date | null;
}

export async function workerStatus(): Promise<WorkerStatus> {
  const [replicas, lastJobRunAt] = await Promise.all([
    liveReplicas().catch(() => null),
    lastSweepAt().catch(() => null),
  ]);
  const workers = (replicas ?? []).filter((replica) => replica.role !== 'web');
  const recentRun =
    lastJobRunAt !== null && Date.now() - lastJobRunAt.getTime() < replicaHeartbeat.staleMs;
  const evidence = runsBackgroundJobs()
    ? 'this-replica'
    : workers.length > 0
      ? 'heartbeat'
      : recentRun
        ? 'job-runs'
        : 'none';
  return { alive: evidence !== 'none', evidence, replicas, lastJobRunAt };
}

export const NO_WORKER_MESSAGE =
  'No background worker has checked in recently: imports, embeddings, conversation summaries, webhooks, backups, compliance exports and retention are not running. Every replica runs OCI_ROLE=web; start at least one with OCI_ROLE=worker (or all).';

/** The System health row. */
export async function workersHealthCheck() {
  const status = await workerStatus();
  const count = (role: ProcessRole) =>
    (status.replicas ?? []).filter((replica) => replica.role === role).length;
  // Only the roles seen, and `all` in words: "0 all" read as nonsense (#228).
  const roles = [
    [count('web'), 'web'],
    [count('worker'), 'worker'],
    [count('all'), 'serving and running jobs (OCI_ROLE=all)'],
  ] as const;
  const seenRoles = roles.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}`);
  const seen = status.replicas
    ? ` Replicas seen in the last minute: ${seenRoles.join(', ') || 'none'}.`
    : '';
  const id = 'workers';
  const label = 'Background workers';
  if (!status.alive) return { id, label, status: 'error' as const, detail: NO_WORKER_MESSAGE };
  // Jobs ran recently but no worker is beating. Without Redis there are no
  // heartbeats to see; with Redis, a worker has most likely just stopped,
  // which this used to report as "no Redis" and ok.
  if (status.evidence === 'job-runs' && status.replicas !== null) {
    return {
      id,
      label,
      status: 'warn' as const,
      detail: `Background jobs ran in the last minute, but no worker has checked in: one may have just stopped.${seen}`,
    };
  }
  const detail =
    status.evidence === 'this-replica'
      ? `This replica (OCI_ROLE=${processRole()}) runs background jobs.${seen}`
      : status.evidence === 'heartbeat'
        ? `Background jobs run on another replica.${seen}`
        : 'Background jobs ran in the last minute (no Redis, so replicas are not listed).';
  return { id, label, status: 'ok' as const, detail };
}

/**
 * On a `web` replica: logs a warning when no worker has checked in, once at
 * first and every ten minutes while it lasts, and a line when one is back.
 */
export function watchForWorkers(options: { firstCheckMs?: number; intervalMs?: number } = {}) {
  const intervalMs = options.intervalMs ?? 60_000;
  let missingSince: number | null = null;
  let warnedAt = 0;
  const check = async () => {
    const status = await workerStatus().catch(() => null);
    if (!status) return;
    if (status.alive) {
      if (missingSince !== null)
        logger.info({ evidence: status.evidence }, 'A background worker is running again');
      missingSince = null;
      return;
    }
    missingSince ??= Date.now();
    if (Date.now() - warnedAt >= 10 * 60_000) {
      warnedAt = Date.now();
      logger.warn(
        { missingForMs: Date.now() - missingSince, role: processRole() },
        NO_WORKER_MESSAGE,
      );
    }
  };
  // Give workers started alongside this replica time for a first heartbeat.
  const first = setTimeout(() => void check(), options.firstCheckMs ?? 60_000);
  const timer = setInterval(() => void check(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
