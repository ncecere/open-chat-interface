import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Returns how many items it touched, for the run record. */
  run: () => Promise<number>;
}

/**
 * Stable 64-bit key for a job's advisory lock. Names are hashed rather than
 * enumerated so adding a job never requires picking an unused integer.
 */
function lockKey(jobName: string): string {
  return `oci:job:${jobName}`;
}

/**
 * Runs a job only if this replica wins its advisory lock.
 *
 * Every replica ticks on the same schedule; without this they would all run
 * the same cleanup simultaneously. A session-level lock is used rather than a
 * transaction lock because a job performs many independent transactions and
 * must hold exclusivity across all of them.
 *
 * A replica that cannot acquire the lock skips silently: another one is
 * already doing the work, which is the desired outcome, not an error.
 */
export async function runExclusively(job: JobDefinition): Promise<number | null> {
  const key = lockKey(job.name);

  const [acquired] = await db.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_lock(hashtext(${key})) as locked`,
  );
  if (!acquired?.locked) return null;

  const startedAt = new Date();
  const [record] = await db
    .insert(schema.jobRun)
    .values({ jobName: job.name, startedAt, status: 'running' })
    .returning({ id: schema.jobRun.id });

  try {
    const itemsProcessed = await job.run();
    const durationMs = Date.now() - startedAt.getTime();

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
  } finally {
    // Always release: a session-level lock outlives the transaction and would
    // otherwise wedge this job until the connection is recycled.
    await db
      .execute(sql`select pg_advisory_unlock(hashtext(${key}))`)
      .catch((error) => logger.error({ error, job: job.name }, 'Failed to release job lock'));
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
