import { sql } from '@oci/db';
import { openControlClient } from '../../db/control.js';
import { db } from '../../db/index.js';
import { isDraining } from '../../lib/drain.js';
import { conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { runsBackgroundJobs } from '../../lib/role.js';

/**
 * Work a request asks for, on a replica that does not run jobs (v0.11 design,
 * item 14).
 *
 * Several requests start background work straight away instead of waiting
 * for the job's next tick: an upload starts its import, an audit event its
 * webhook deliveries, a long reply its summary, a project file its embedding,
 * and administrators run jobs, backups and exports by hand. On an `all`
 * replica that work runs in the same process, as before. On a `web` replica
 * it must not (that is the point of the role), so the request records the
 * work as before (rows in the import, webhook, compaction or passage tables)
 * and sends a PostgreSQL notification asking a worker to start now. If no
 * worker hears it, nothing is lost: the job's next tick finds the same rows.
 *
 * Manual backups and compliance exports have no queue row; they are carried
 * in the notification, and refused up front when no worker is running.
 */
export const JOB_REQUEST_CHANNEL = 'oci_job_requests';

export interface JobRequest {
  job: string;
  /** Who asked, for a manual backup or compliance export. */
  actor?: { id: string; email: string };
}

/** Collapses a burst of kicks for one job into one notification. */
const KICK_COALESCE_MS = 250;
const pendingKicks = new Map<string, NodeJS.Timeout>();

/**
 * NOTIFY is delivered when its transaction commits, so it works through a
 * transaction-mode pooler on the application pool; only LISTEN needs a
 * session of its own (a control connection).
 */
async function notify(request: JobRequest): Promise<void> {
  await db.execute(sql`select pg_notify(${JOB_REQUEST_CHANNEL}, ${JSON.stringify(request)})`);
}

/**
 * Starts a queued job's work soon: here when this replica runs jobs, else on
 * a worker. Fire and forget; the job's tick is the fallback either way.
 * Without `runHere`, a replica that runs jobs leaves it to the tick.
 */
export function kickJob(job: string, runHere?: () => unknown): void {
  if (runsBackgroundJobs()) {
    runHere?.();
    return;
  }
  if (pendingKicks.has(job)) return;
  const timer = setTimeout(() => {
    pendingKicks.delete(job);
    notify({ job }).catch((error: unknown) =>
      logger.warn({ err: String(error), job }, 'Could not ask a worker to start a job'),
    );
  }, KICK_COALESCE_MS);
  timer.unref();
  pendingKicks.set(job, timer);
}

/**
 * Asks a worker to run something an administrator started. `local` when this
 * replica runs it itself; `no-worker` when no replica runs jobs, so the
 * caller can say so instead of reporting something that will never happen.
 */
export async function requestManualRun(
  request: JobRequest,
): Promise<'local' | 'queued' | 'no-worker'> {
  if (runsBackgroundJobs()) return 'local';
  const { workerStatus } = await import('./workers.js');
  const status = await workerStatus();
  if (!status.alive) return 'no-worker';
  await notify(request);
  return 'queued';
}

/** 409 for work an administrator started when no replica runs jobs. */
export function manualRunConflict() {
  return conflict(
    'No background worker is running, so this cannot start. Start a replica with OCI_ROLE=worker (or all), then try again.',
  );
}

function parseRequest(payload: string): JobRequest | null {
  try {
    const value = JSON.parse(payload) as Partial<JobRequest>;
    if (typeof value?.job !== 'string' || !value.job) return null;
    const actor =
      value.actor && typeof value.actor.id === 'string' && typeof value.actor.email === 'string'
        ? { id: value.actor.id, email: value.actor.email }
        : undefined;
    return { job: value.job, ...(actor ? { actor } : {}) };
  } catch {
    return null;
  }
}

/**
 * On a replica that runs jobs: handles requests from `web` replicas. A request
 * arriving while the same job is running here runs it once more afterwards,
 * so work queued during a pass is not left for the next tick.
 */
export async function listenForJobRequests(
  handle: (request: JobRequest) => Promise<unknown>,
): Promise<() => Promise<void>> {
  const running = new Map<string, { again: boolean }>();
  const dispatch = async (request: JobRequest) => {
    // A manual run carries its actor and is never merged with another.
    if (request.actor) return handle(request);
    const state = running.get(request.job);
    if (state) {
      state.again = true;
      return;
    }
    const current = { again: false };
    running.set(request.job, current);
    try {
      do {
        current.again = false;
        await handle(request);
      } while (current.again && !isDraining());
    } finally {
      running.delete(request.job);
    }
  };
  // A control connection (CONTROL_DATABASE_URL, v0.11 design, section 11):
  // behind a transaction-mode pooler a LISTEN would subscribe whichever
  // server connection ran it, and the notifications would never arrive.
  const client = openControlClient();
  try {
    // postgres.js keeps a dedicated connection for this, and listens again
    // after it reconnects (a failover included).
    const listener = await client.listen(JOB_REQUEST_CHANNEL, (payload) => {
      const request = parseRequest(payload);
      if (!request || isDraining()) return;
      dispatch(request).catch((error: unknown) =>
        logger.warn({ err: String(error), job: request.job }, 'A requested job failed to start'),
      );
    });
    return async () => {
      await listener.unlisten().catch(() => undefined);
      await client.end({ timeout: 1 }).catch(() => undefined);
    };
  } catch (error) {
    // Ticks still run everything; requested work just waits for them.
    await client.end({ timeout: 1 }).catch(() => undefined);
    logger.warn(
      { err: String(error) },
      'Not listening for job requests from web replicas; their work waits for the next tick',
    );
    return async () => {};
  }
}
