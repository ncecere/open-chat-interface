import { createDatabase } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type LockClient = ReturnType<typeof createDatabase>['sql'];
type LockOwner = Awaited<ReturnType<LockClient['reserve']>>;
const localRuns = new Set<string>();

/** How long a lock query may take before the lock is treated as lost. */
const LOCK_QUERY_TIMEOUT_MS = 5_000;

/**
 * How often a running job's lock connection is checked in the background,
 * besides the checks a job makes between its batches (`JobLease.stillHeld`).
 */
export const lockWatch = { intervalMs: 5_000 };

function withDeadline<T>(query: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    query,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), LOCK_QUERY_TIMEOUT_MS);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function unlock(owner: LockOwner, key: string, job: string): Promise<void> {
  try {
    // A lost response must not prevent disposal of the private lock client.
    const [row] = await withDeadline(
      owner<{ unlocked: boolean }[]>`select pg_advisory_unlock(hashtext(${key})) as unlocked`,
      'Timed out releasing job lock',
    );
    if (!row?.unlocked) throw new Error('Job lock was no longer held by its owner');
  } catch (error) {
    logger.error({ error, job }, 'Failed to release job lock; closing its private connection');
  }
}

/**
 * A held job lock, as seen by the job running under it.
 *
 * The lock is a session advisory lock on a private connection. A database
 * failover (or anything else that drops that connection) releases it at
 * once, and another replica may then take the job over, while this one has
 * no way to know unless it asks. So it asks: in the background every few
 * seconds, and whenever the job calls `stillHeld()` between batches. Once
 * lost, the lease stays lost; the next tick acquires a new lock, on whatever
 * is now the primary.
 */
export interface JobLease {
  /** Aborted as soon as the lock is known to be lost. */
  readonly signal: AbortSignal;
  /** Asks the lock's connection whether it still holds the lock. */
  stillHeld(): Promise<boolean>;
  readonly lost: boolean;
}

function createLease(owner: LockOwner, key: string, job: string) {
  const controller = new AbortController();
  let checking: Promise<boolean> | null = null;
  // Called at most once: only one check runs at a time, and none after a loss.
  const lose = (reason: string, error?: unknown) => {
    logger.warn(
      { job, reason, err: error instanceof Error ? error.message : error },
      'Background job lost its lock; it stops at its next check and the next tick takes it again',
    );
    controller.abort(new Error(reason));
  };
  const check = async (): Promise<boolean> => {
    try {
      // The same session that took the lock: an error or a timeout means the
      // connection is gone, and with it the lock.
      const [row] = await withDeadline(
        owner<{ held: boolean }[]>`
          select exists (
            select 1 from pg_locks
            where locktype = 'advisory' and granted and pid = pg_backend_pid()
              and objsubid = 1
              and ((classid::bigint << 32) | objid::bigint) = hashtext(${key})::bigint
          ) as held
        `,
        'Timed out checking the job lock',
      );
      if (!row?.held) lose('The job lock is no longer held by its connection');
    } catch (error) {
      lose('The job lock connection was lost', error);
    }
    return !controller.signal.aborted;
  };
  const lease: JobLease = {
    signal: controller.signal,
    get lost() {
      return controller.signal.aborted;
    },
    stillHeld() {
      if (controller.signal.aborted) return Promise.resolve(false);
      // One query at a time on the private connection.
      checking ??= check().finally(() => {
        checking = null;
      });
      return checking;
    },
  };
  const timer = setInterval(() => void lease.stillHeld(), lockWatch.intervalMs);
  timer.unref();
  return {
    lease,
    /** Stops watching; resolves once any check in progress has finished. */
    stop: async () => {
      clearInterval(timer);
      await checking;
    },
  };
}

/**
 * Session-lock lifetime, independent of job work and run-record persistence.
 * One private client per attempt avoids pinning all connections in the work
 * pool when several jobs run together. It is always closed, never recycled
 * after a failed unlock. Local duplicate ticks do not open extra connections.
 *
 * Requires a direct PostgreSQL connection or session-mode pooler, not a
 * transaction-mode pooler. This is mutual exclusion, not exactly-once delivery:
 * a job that loses its lock (its connection dropped) learns of it at its next
 * check, so another replica's run can overlap the batch in progress by at most
 * that batch. Job bodies are written to be safe to re-run.
 */
export async function withJobLock<T>(
  name: string,
  work: (lease: JobLease) => Promise<T>,
): Promise<T | null> {
  if (localRuns.has(name)) return null;
  localRuns.add(name);
  try {
    const client = createDatabase(loadEnv().DATABASE_URL, { max: 1 }).sql;
    try {
      const owner = await client.reserve();
      try {
        // Preserve the existing hashtext key for mixed-version deployments.
        // Its 32-bit collisions can serialize unrelated jobs, not overlap them.
        const key = `oci:job:${name}`;
        const [row] = await owner<{ locked: boolean }[]>`
          select pg_try_advisory_lock(hashtext(${key})) as locked
        `;
        if (!row?.locked) return null;
        const { lease, stop } = createLease(owner, key, name);
        try {
          // No fallible work, including the run-record insert, precedes this
          // cleanup boundary once acquisition has succeeded.
          return await work(lease);
        } finally {
          await stop();
          // A lost lock is gone with its connection: nothing to release.
          if (!lease.lost) await unlock(owner, key, name);
        }
      } finally {
        owner.release();
      }
    } finally {
      // Even a failed/ambiguous acquisition or unlock cannot return a possibly
      // locked session to the application's pool. The pinned driver patch makes
      // this deadline destroy the socket, rather than only sending TCP FIN.
      await client.end({ timeout: 1 });
    }
  } finally {
    localRuns.delete(name);
  }
}
