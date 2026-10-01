import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type Database } from './client.js';
import * as schema from './schema/index.js';

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
  /** True after the migrator completes, including an already-current no-op run. */
  applied: boolean;
}

/**
 * Pin lock acquisition, journal reads and DDL to one physical transaction.
 * A max:1 pool alone may reconnect between statements and silently lose a
 * session lock. Postgres.js transaction scopes instead fail on connection loss.
 * Drizzle's inner migration transaction becomes a savepoint on this same scope;
 * the transaction advisory lock remains held through the outer commit/rollback.
 */
export async function runMigrationsWithLock(
  connectionString: string,
  options: { timeoutMs?: number } = {},
): Promise<MigrationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;

  const { sql: client } = createDatabase(connectionString, { max: 1 });

  try {
    const deadline = Date.now() + timeoutMs;
    // Await inside the cleanup boundary: never close the client before COMMIT.
    // Journal reads must see the preceding owner's commit after a lock wait,
    // even if the server's default isolation is repeatable read/serializable.
    return await client.begin('isolation level read committed', async (transaction) => {
      while (true) {
        const [row] = await transaction<[{ locked: boolean }]>`
          select pg_try_advisory_xact_lock(${MIGRATION_LOCK_KEY}::bigint) as locked
        `;
        if (row?.locked) break;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for the migration lock. Another instance may be stuck migrating.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // The installed Drizzle adapter requires options (type parsers) and begin.
      // Supply only those on the pinned transaction client, mapping its inner
      // begin to a real savepoint. Do NOT copy pool methods: unsafe/query calls
      // must remain bound to the physical transaction, even after disconnect.
      // This narrowed adapter is only used by the migrator, not general callers.
      const migrationClient = Object.assign(transaction, {
        options: client.options,
        begin: transaction.savepoint,
      });
      const db = drizzle(migrationClient as unknown as typeof client, {
        schema,
        casing: 'snake_case',
      });
      await runMigrations(db);
      return { applied: true };
    });
  } finally {
    // Transaction end releases the advisory lock. Close the private pool on
    // success, failure and no-op; cleanup must not reconnect just to unlock.
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Require the latest bundled migration's recorded timestamp before a replica
 * serves without migrating. This checks migration history, not physical schema
 * integrity or compatibility with additional, newer migrations.
 */
export async function migrationsApplied(db: Database): Promise<boolean> {
  try {
    const latest = readMigrationFiles({ migrationsFolder }).at(-1);
    if (!latest) return false;
    const rows = await db.execute<{ applied: boolean }>(sql`
      select exists (
        select 1 from drizzle.__drizzle_migrations
        where created_at = ${latest.folderMillis}::bigint
      ) as applied
    `);
    return rows[0]?.applied === true;
  } catch {
    return false;
  }
}
