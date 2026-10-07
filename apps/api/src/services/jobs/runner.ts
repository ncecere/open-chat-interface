import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, inArray, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { retryOnConnectionError } from '../../lib/db-connection.js';
import { isDraining } from '../../lib/drain.js';
import { logger } from '../../lib/logger.js';
import { observeJob } from '../observability/events.js';
import { withSpan } from '../observability/tracing.js';
import { type JobLease, withJobLock } from './lock.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /**
   * Also run once shortly after the process starts, instead of waiting a whole
   * interval: for work that may have queued up while no worker was running.
   */
  runOnStart?: boolean;
  /** Returns how many items it touched, for the run record. */
  run: () => Promise<number>;
}

const running = new Set<Promise<unknown>>();
const leases = new AsyncLocalStorage<{ lease: JobLease; job: string }>();

/**
 * Whether a job should not run now (read-only maintenance mode, v0.11: jobs
 * that write pause unless chosen to keep running). Set by jobs/index.ts; a
 * paused job is not started, and one running stops at its next check between
 * batches (`jobMayContinue`), as on a shutdown.
 */
let pausedNow: (job: string) => Promise<boolean> = async () => false;

export function setJobPauseCheck(check: (job: string) => Promise<boolean>): void {
  pausedNow = check;
}

/** Recorded on a run cut short because its lock went with its connection. */
export const LOST_LOCK_MESSAGE =
  'Stopped early: the job lost its lock when its database connection closed (a failover?). The next run continues.';

/**
 * The check a job makes between batches (v0.11): false once this replica is
 * shutting down (finish the batch in hand, start no other), or once the job's
 * lock is lost with its connection (a database failover), in which case
 * another replica may already be running it. Outside a job (a pass kicked by
 * a request, which relies on row leases instead) only the shutdown counts.
 */
export async function jobMayContinue(): Promise<boolean> {
  if (isDraining()) return false;
  const current = leases.getStore();
  if (!current) return true;
  if (await pausedNow(current.job)) return false;
  return current.lease.stillHeld();
}

/**
 * Returns null when another local tick or database session owns this job,
 * when this replica is shutting down (it starts no new work then: a kick from
 * a request, a manual run; another replica's tick picks the work up), or
 * while the job is paused (read-only mode).
 */
export function runExclusively(job: JobDefinition): Promise<number | null> {
  if (isDraining()) return Promise.resolve(null);
  const run = pausedNow(job.name).then((paused) =>
    paused
      ? null
      : withJobLock(job.name, (lease) =>
          leases.run({ lease, job: job.name }, () => runRecordedJob(job, lease)),
        ),
  );
  running.add(run);
  void run.catch(() => undefined).finally(() => running.delete(run));
  return run;
}

/** Jobs this process is running; a shutdown waits for them within its limit. */
export function runningJobCount(): number {
  return running.size;
}

/** Lock cleanup surrounds the entire callback, including this initial insert. */
async function runRecordedJob(job: JobDefinition, lease: JobLease): Promise<number> {
  const startedAt = new Date();
  const [record] = await db
    .insert(schema.jobRun)
    .values({ jobName: job.name, startedAt, status: 'running' })
    .returning({ id: schema.jobRun.id });

  try {
    const itemsProcessed = await withSpan(`job ${job.name}`, { 'oci.job.name': job.name }, (span) =>
      job.run().then((items) => {
        span.setAttributes({ 'oci.job.items': items });
        return items;
      }),
    );
    const durationMs = Date.now() - startedAt.getTime();
    // Its batches so far are done and counted; the run itself was cut short.
    const status = lease.lost ? 'error' : 'success';
    observeJob(job.name, status, durationMs);

    if (record) {
      // Through a failover too, or the run would read as running for ever.
      await retryOnConnectionError(() =>
        db
          .update(schema.jobRun)
          .set({
            finishedAt: new Date(),
            durationMs,
            itemsProcessed,
            status,
            ...(lease.lost ? { errorMessage: LOST_LOCK_MESSAGE } : {}),
          })
          .where(eq(schema.jobRun.id, record.id)),
      );
    }
    if (lease.lost) {
      logger.warn({ job: job.name, itemsProcessed, durationMs }, LOST_LOCK_MESSAGE);
      return itemsProcessed;
    }

    if (itemsProcessed > 0) {
      logger.info({ job: job.name, itemsProcessed, durationMs }, 'Background job completed');
    }
    return itemsProcessed;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = lease.lost ? `${LOST_LOCK_MESSAGE} (${cause})` : cause;
    logger.error({ job: job.name, error: message }, 'Background job failed');
    observeJob(job.name, 'error', Date.now() - startedAt.getTime());

    if (record) {
      const finishedAt = new Date();
      await retryOnConnectionError(() =>
        db
          .update(schema.jobRun)
          .set({
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            status: 'error',
            errorMessage: message.slice(0, 1_000),
          })
          .where(eq(schema.jobRun.id, record.id)),
      ).catch(() => undefined);
    }
    return 0;
  }
}

const timers: NodeJS.Timeout[] = [];
const START_DELAY_MS = 1_000;

/** Starts every job on its own interval. Safe to call once per process. */
export function startJobs(jobs: JobDefinition[]): void {
  for (const job of jobs) {
    const tick = () => {
      void runExclusively(job).catch((error) =>
        logger.error({ error, job: job.name }, 'Background job tick failed'),
      );
    };

    const timer = setInterval(tick, job.intervalMs);
    timer.unref();
    timers.push(timer);
    if (job.runOnStart) {
      // A second in, once the process has settled; the lock still keeps two
      // replicas from running it together.
      const first = setTimeout(tick, START_DELAY_MS);
      first.unref();
      timers.push(first);
    }
  }
}

export function stopJobs(): void {
  // clearInterval also clears a timeout: both are timers in Node.
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}

/**
 * The most recent run of each named job, for the admin health view. One index
 * lookup per name (job_run_name_started_idx), so a daily job is found however
 * many runs the minute-by-minute jobs have recorded since (#215); the newest N
 * runs across all jobs covered only a few minutes.
 */
export async function latestJobRuns(names: string[]) {
  if (names.length === 0) return [];
  const latest = await db.execute<{ id: string }>(sql`
    select last.id
    from unnest(array[${sql.join(
      names.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]) as job(name)
    cross join lateral (
      select ${schema.jobRun.id} as id
      from ${schema.jobRun}
      where ${schema.jobRun.jobName} = job.name
      order by ${schema.jobRun.startedAt} desc
      limit 1
    ) as last
  `);
  const ids = latest.map((row) => row.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.jobRun).where(inArray(schema.jobRun.id, ids));
}
