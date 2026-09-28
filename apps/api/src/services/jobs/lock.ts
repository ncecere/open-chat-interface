import { createDatabase } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type LockClient = ReturnType<typeof createDatabase>['sql'];
type LockOwner = Awaited<ReturnType<LockClient['reserve']>>;
const localRuns = new Set<string>();

async function unlock(owner: LockOwner, key: string, job: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A lost response must not prevent disposal of the private lock client.
    const [row] = await Promise.race([
      owner<{ unlocked: boolean }[]>`select pg_advisory_unlock(hashtext(${key})) as unlocked`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out releasing job lock')), 5_000);
        timer.unref();
      }),
    ]);
    if (!row?.unlocked) throw new Error('Job lock was no longer held by its owner');
  } catch (error) {
    logger.error({ error, job }, 'Failed to release job lock; closing its private connection');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Session-lock lifetime, independent of job work and run-record persistence.
 * One private client per attempt avoids pinning all connections in the work
 * pool when several jobs run together. It is always closed, never recycled
 * after a failed unlock. Local duplicate ticks do not open extra connections.
 *
 * Requires a direct PostgreSQL connection or session-mode pooler, not a
 * transaction-mode pooler. This is mutual exclusion, not exactly-once delivery
 * or fencing against a database connection disappearing during external work.
 */
export async function withJobLock<T>(name: string, work: () => Promise<T>): Promise<T | null> {
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
        try {
          // No fallible work, including the run-record insert, precedes this
          // cleanup boundary once acquisition has succeeded.
          return await work();
        } finally {
          await unlock(owner, key, name);
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
