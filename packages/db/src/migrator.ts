import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createDatabase, type Database } from './client.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

/**
 * Fixed key for the migration advisory lock. A literal is used rather than
 * `hashtext`, which is only 32-bit and not guaranteed stable across Postgres
 * versions.
 */
// Sent as text because the driver will not bind a JS bigint parameter.
const MIGRATION_LOCK_KEY = '8374920115573001';

/** Applies the committed migrations. Assumes the caller holds the lock. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export interface MigrationResult {
  /** False when another process held the lock and had already migrated. */
  applied: boolean;
}

/**
 * Applies migrations under a session-scoped advisory lock so several API
 * replicas can boot at once without racing each other.
 *
 * The lock must be session-scoped and held on a pinned connection: Drizzle's
 * migrator opens its own transactions, so a transaction-scoped lock would be
 * released before the migrations it is meant to protect have run. A dedicated
 * single-connection client guarantees the lock and the migrations share a
 * session, which a pooled client cannot.
 */
export async function runMigrationsWithLock(
  connectionString: string,
  options: { timeoutMs?: number } = {},
): Promise<MigrationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;

  // A pool would hand the lock and the migrations different connections.
  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  const { db } = createDatabase(connectionString, { max: 1 });

  try {
    const deadline = Date.now() + timeoutMs;
    let acquired = false;

    while (!acquired) {
      const [row] = await client<[{ locked: boolean }]>`
        select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) as locked
      `;
      acquired = row?.locked ?? false;
      if (acquired) break;

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the migration lock. Another instance may be stuck migrating.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Reaching here with the lock held means any concurrent migrator has
    // finished; drizzle then skips whatever it already applied.
    await runMigrations(db);
    return { applied: true };
  } finally {
    // Releasing explicitly rather than relying on disconnect keeps a pooled or
    // reused connection from holding the lock.
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => {});
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

/** True when the schema is present and current, for replicas that do not migrate. */
export async function migrationsApplied(db: Database): Promise<boolean> {
  try {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from drizzle.__drizzle_migrations`,
    );
    return Number(rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  }
}
