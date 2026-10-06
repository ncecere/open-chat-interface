import { randomUUID } from 'node:crypto';
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
 *
 * A notification nobody is listening for is lost, and a worker that has just
 * stopped (or crashed) still looks alive for up to a minute: its heartbeat,
 * or the sweep it ran, is still recent. So a run an administrator starts is
 * confirmed: the worker answers on JOB_ACK_CHANNEL as it takes the request,
 * and a request no worker takes in time is reported as not started (#265).
 */
export const JOB_REQUEST_CHANNEL = 'oci_job_requests';
export const JOB_ACK_CHANNEL = 'oci_job_request_acks';

/** How long a `web` replica waits for a worker to take a manual run (#265). */
export const manualRunAck = { timeoutMs: 5_000 };

export interface JobRequest {
  job: string;
  /** Who asked, for a manual backup or compliance export. */
  actor?: { id: string; email: string };
  /** Set on a manual run: the worker that takes it answers with it (#265). */
  requestId?: string;
}

export type ManualRunPlacement = 'local' | 'queued' | 'no-worker' | 'unanswered';

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

async function acknowledge(requestId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${JOB_ACK_CHANNEL}, ${requestId})`);
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
 * replica runs it itself; `queued` once a worker has taken it; `no-worker`
 * when no replica runs jobs, and `unanswered` when none took it in time (one
 * that has just stopped still looks alive for a minute), so the caller can
 * say so instead of reporting something that will never happen (#265).
 */
export async function requestManualRun(request: JobRequest): Promise<ManualRunPlacement> {
  if (runsBackgroundJobs()) return 'local';
  const { workerStatus } = await import('./workers.js');
  const status = await workerStatus();
  if (!status.alive) return 'no-worker';

  const requestId = randomUUID();
  let taken!: () => void;
  const answer = new Promise<'queued'>((resolve) => {
    taken = () => resolve('queued');
  });
  // The answer is a notification too, so it needs a session that LISTENs: a
  // control connection, as the worker's (v0.11 design, section 11).
  const client = openControlClient();
  let timer: NodeJS.Timeout | undefined;
  try {
    const listener = await client.listen(JOB_ACK_CHANNEL, (payload) => {
      if (payload === requestId) taken();
    });
    try {
      await notify({ ...request, requestId });
      const late = new Promise<'unanswered'>((resolve) => {
        timer = setTimeout(() => resolve('unanswered'), manualRunAck.timeoutMs);
      });
      return await Promise.race([answer, late]);
    } finally {
      await listener.unlisten().catch(() => undefined);
    }
  } catch (error) {
    // Without a way to hear the answer, the run cannot be confirmed; the
    // worker could not hear the request either if LISTEN fails here.
    logger.warn({ err: error, job: request.job }, 'Could not ask a worker to run a job');
    return 'unanswered';
  } finally {
    clearTimeout(timer);
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * 409 for work an administrator started that no worker will run: none is
 * running, or none took the request in time (#265).
 */
export function manualRunConflict(placement: 'no-worker' | 'unanswered' = 'no-worker') {
  return conflict(
    placement === 'unanswered'
      ? `No background worker took this request within ${manualRunAck.timeoutMs / 1000} seconds, so it has not started. A worker may have just stopped or be restarting: check Background workers in System health, then try again.`
      : 'No background worker is running, so this cannot start. Start a replica with OCI_ROLE=worker (or all), then try again.',
  );
}

/** Throws the 409 for a manual run no worker will run. */
export function assertManualRunPlaced(placement: ManualRunPlacement): 'local' | 'queued' {
  if (placement === 'no-worker' || placement === 'unanswered') throw manualRunConflict(placement);
  return placement;
}

function parseRequest(payload: string): JobRequest | null {
  try {
    const value = JSON.parse(payload) as Partial<JobRequest>;
    if (typeof value?.job !== 'string' || !value.job) return null;
    const actor =
      value.actor && typeof value.actor.id === 'string' && typeof value.actor.email === 'string'
        ? { id: value.actor.id, email: value.actor.email }
        : undefined;
    const requestId =
      typeof value.requestId === 'string' && value.requestId.length <= 64
        ? value.requestId
        : undefined;
    return { job: value.job, ...(actor ? { actor } : {}), ...(requestId ? { requestId } : {}) };
  } catch {
    return null;
  }
}

/**
 * On a replica that runs jobs: handles requests from `web` replicas. A request
 * arriving while the same job is running here runs it once more afterwards,
 * so work queued during a pass is not left for the next tick.
 *
 * A manual run (one with a `requestId`) is answered as it is taken, unless
 * this replica is draining or `accepts` says it cannot run it (a job its
 * settings leave off, #256): then the web replica reports it as not started.
 */
export async function listenForJobRequests(
  handle: (request: JobRequest) => Promise<unknown>,
  accepts: (request: JobRequest) => boolean = () => true,
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
      if (request.requestId) {
        if (!accepts(request)) {
          logger.warn(
            { job: request.job },
            'Refused a request to run a job this replica does not run',
          );
          return;
        }
        acknowledge(request.requestId).catch((error: unknown) =>
          logger.warn({ err: error, job: request.job }, 'Could not confirm a requested run'),
        );
      }
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
