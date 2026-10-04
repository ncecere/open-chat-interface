import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { isDraining } from '../../lib/drain.js';
import { logger } from '../../lib/logger.js';
import { observeJob } from '../observability/events.js';
import { withSpan } from '../observability/tracing.js';
import { withJobLock } from './lock.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Returns how many items it touched, for the run record. */
  run: () => Promise<number>;
}

const running = new Set<Promise<unknown>>();

/**
 * Returns null when another local tick or database session owns this job, or
 * when this replica is shutting down: it starts no new work then (a kick from
 * a request, a manual run), and another replica's tick picks the work up.
 */
export function runExclusively(job: JobDefinition): Promise<number | null> {
  if (isDraining()) return Promise.resolve(null);
  const run = withJobLock(job.name, () => runRecordedJob(job));
  running.add(run);
  void run.catch(() => undefined).finally(() => running.delete(run));
  return run;
}

/** Jobs this process is running; a shutdown waits for them within its limit. */
export function runningJobCount(): number {
  return running.size;
}

/** Lock cleanup surrounds the entire callback, including this initial insert. */
async function runRecordedJob(job: JobDefinition): Promise<number> {
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
    observeJob(job.name, 'success', durationMs);

    if (record) {
      await db
        .update(schema.jobRun)
        .set({ finishedAt: new Date(), durationMs, itemsProcessed, status: 'success' })
        .where(eq(schema.jobRun.id, record.id));
    }

    if (itemsProcessed > 0) {
      logger.info({ job: job.name, itemsProcessed, durationMs }, 'Background job completed');
    }
    return itemsProcessed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ job: job.name, error: message }, 'Background job failed');
    observeJob(job.name, 'error', Date.now() - startedAt.getTime());

    if (record) {
      await db
        .update(schema.jobRun)
        .set({
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
          status: 'error',
          errorMessage: message.slice(0, 1_000),
        })
        .where(eq(schema.jobRun.id, record.id))
        .catch(() => undefined);
    }
    return 0;
  }
}

const timers: NodeJS.Timeout[] = [];

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
  }
}

export function stopJobs(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}

/** Most recent run of each job, for the admin health view. */
export async function recentJobRuns(limit = 50) {
  return db
    .select()
    .from(schema.jobRun)
    .orderBy(sql`${schema.jobRun.startedAt} desc`)
    .limit(Math.max(1, Math.min(limit, 200)));
}
