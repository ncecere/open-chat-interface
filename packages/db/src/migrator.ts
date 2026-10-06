import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type Database } from './client.js';
import {
  DEFAULT_MIGRATION_MAX_ATTEMPTS,
  DEFAULT_MIGRATION_MAX_RETRY_DELAY_MS,
  DEFAULT_MIGRATION_RETRY_DELAY_MS,
  failedStatement,
  isLockTimeout,
  type LockWait,
  MigrationLockTimeoutError,
  type MigrationRetryEvent,
  migrationRetryDelay,
  migrationTimeoutsFromEnv,
  startLockMonitor,
} from './migration-safety.js';
import {
  type ReleaseEntry,
  UnfinishedRequirementsError,
  unfinishedRequirements,
} from './release-manifest.js';
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
export async function runMigrations(
  db: Database,
  folder: string = migrationsFolder,
): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}

export interface MigrationResult {
  /** True after the migrator completes, including an already-current no-op run. */
  applied: boolean;
}

export interface MigrationOptions {
  /** How long one attempt waits for the migration advisory lock (default 60s). */
  timeoutMs?: number;
  /** Test seam: a Drizzle migrations folder other than the bundled one. */
  migrationsFolder?: string;
  /** `lock_timeout` per statement; default MIGRATION_LOCK_TIMEOUT_MS or 3000. */
  lockTimeoutMs?: number;
  /** `statement_timeout` per statement; default MIGRATION_STATEMENT_TIMEOUT_MS or 15 minutes. */
  statementTimeoutMs?: number;
  /** `idle_in_transaction_session_timeout` for the migration session (default 10s). */
  idleInTransactionTimeoutMs?: number;
  /** Attempts before a lock timeout becomes a failure (default 10). */
  maxAttempts?: number;
  /** First backoff after a lock timeout; doubles per attempt (default 1s). */
  retryDelayMs?: number;
  /** Backoff ceiling (default 30s). Ten attempts span roughly three minutes. */
  maxRetryDelayMs?: number;
  /**
   * Called before each retry. Defaults to one warning through `logger`, or a
   * line on stderr without one.
   */
  onRetry?: (event: MigrationRetryEvent) => void;
  /** A structured logger (pino's shape) for retry warnings, instead of stderr. */
  logger?: MigrationLogger;
  /**
   * Test seam: the release manifest (default `releases.json`). Pending
   * migrations of a release that requires unfinished post-deploy steps or
   * background migrations are refused before anything is applied.
   */
  releaseManifest?: ReleaseEntry[];
}

/** The part of a pino-style logger the migrator uses. */
export interface MigrationLogger {
  warn: (details: Record<string, unknown>, message: string) => void;
}

function retryMessage(event: MigrationRetryEvent): string {
  const blockers = event.blockers.map((blocker) => blocker.pid).join(', ') || 'unknown';
  return (
    `Database migration attempt ${event.attempt}/${event.maxAttempts} timed out waiting for ` +
    `${event.mode ?? 'a lock'} on ${event.relation ?? 'an unidentified object'} ` +
    `(blocking pid ${blockers}); rolled back, retrying in ${event.delayMs}ms.`
  );
}

function retryReporter(logger?: MigrationLogger): (event: MigrationRetryEvent) => void {
  if (!logger) return (event) => console.warn(retryMessage(event));
  return (event) =>
    logger.warn(
      {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        relation: event.relation,
        mode: event.mode,
        blockingPids: event.blockers.map((blocker) => blocker.pid),
        statement: event.statement,
      },
      retryMessage(event),
    );
}

/**
 * Pin lock acquisition, journal reads and DDL to one physical transaction.
 * A max:1 pool alone may reconnect between statements and silently lose a
 * session lock. Postgres.js transaction scopes instead fail on connection loss.
 * Drizzle's inner migration transaction becomes a savepoint on this same scope;
 * the transaction advisory lock remains held through the outer commit/rollback.
 *
 * Every statement runs with transaction-local lock and statement timeouts (v0.11
 * design, section 2). A lock timeout (SQLSTATE 55P03) rolls the whole attempt
 * back, releasing the advisory lock, and the attempt is retried with backoff;
 * after the last attempt the error names the relation and the blocking session.
 * Any other error fails at once, as before.
 */
export async function runMigrationsWithLock(
  connectionString: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const fromEnv = migrationTimeoutsFromEnv();
  const timeouts = {
    lockTimeoutMs: options.lockTimeoutMs ?? fromEnv.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs ?? fromEnv.statementTimeoutMs,
    idleInTransactionTimeoutMs:
      options.idleInTransactionTimeoutMs ?? fromEnv.idleInTransactionTimeoutMs,
  };
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MIGRATION_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_MIGRATION_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MIGRATION_MAX_RETRY_DELAY_MS;
  const onRetry = options.onRetry ?? retryReporter(options.logger);
  // Sample often enough to see every lock wait before lock_timeout ends it.
  const monitorIntervalMs = Math.min(1_000, Math.max(25, Math.floor(timeouts.lockTimeoutMs / 3)));

  const { sql: client } = createDatabase(connectionString, { max: 1 });

  try {
    for (let attempt = 1; ; attempt++) {
      let lockWait: LockWait | null = null;
      try {
        // Await inside the cleanup boundary: never close the client before COMMIT.
        // Journal reads must see the preceding owner's commit after a lock wait,
        // even if the server's default isolation is repeatable read/serializable.
        return await client.begin('isolation level read committed', async (transaction) => {
          // set_config(..., true) is SET LOCAL: it ends with this transaction and
          // also covers Drizzle's savepoint and its bookkeeping statements.
          const [session] = await transaction<[{ pid: number }]>`
            select pg_backend_pid() as pid,
              set_config('idle_in_transaction_session_timeout',
                ${String(timeouts.idleInTransactionTimeoutMs)}, true),
              set_config('lock_timeout', ${String(timeouts.lockTimeoutMs)}, true),
              set_config('statement_timeout', ${String(timeouts.statementTimeoutMs)}, true)
          `;
          const deadline = Date.now() + timeoutMs;
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

          const monitor = startLockMonitor(connectionString, session!.pid, monitorIntervalMs);
          try {
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
            // Finalisation (v0.11 design, section 1): a release may rely on an
            // earlier release's backfill or index. Checked under the lock, so
            // the answer cannot change before the migrations below run.
            const unfinished = await unfinishedRequirements(transaction, {
              migrationsFolder: options.migrationsFolder ?? migrationsFolder,
              manifest: options.releaseManifest,
            });
            if (unfinished.length > 0) throw new UnfinishedRequirementsError(unfinished);
            await runMigrations(db, options.migrationsFolder);
            return { applied: true };
          } finally {
            lockWait = monitor.latest();
            await monitor.stop();
          }
        });
      } catch (error) {
        if (!isLockTimeout(error)) throw error;
        const statement = failedStatement(error);
        if (attempt >= maxAttempts) {
          throw new MigrationLockTimeoutError({
            attempts: attempt,
            lockTimeoutMs: timeouts.lockTimeoutMs,
            lockWait,
            statement,
            cause: error,
          });
        }
        const delayMs = migrationRetryDelay(attempt, retryDelayMs, maxRetryDelayMs);
        const wait = lockWait as LockWait | null;
        onRetry({
          attempt,
          maxAttempts,
          delayMs,
          relation: wait?.relation ?? null,
          mode: wait?.mode ?? null,
          blockers: wait?.blockers ?? [],
          statement,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    // Transaction end releases the advisory lock. Close the private pool on
    // success, failure and no-op; cleanup must not reconnect just to unlock.
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

/** SQLSTATEs of a database with no migration history: no table, no schema. */
const NO_MIGRATION_HISTORY = new Set(['42P01', '3F000']);

function sqlState(error: unknown): string | undefined {
  // Drizzle wraps the driver's error in a DrizzleQueryError.
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

/**
 * Require the latest bundled migration's recorded timestamp before a replica
 * serves without migrating. This checks migration history, not physical schema
 * integrity or compatibility with additional, newer migrations.
 *
 * Only a database without the history table answers `false`. Any other error
 * (the database unreachable, starting up or shutting down) is thrown: it is no
 * answer, and reading it as "not recorded" told operators to run migrations
 * while PostgreSQL was simply down (#137).
 */
export async function migrationsApplied(db: Database): Promise<boolean> {
  const latest = readMigrationFiles({ migrationsFolder }).at(-1);
  if (!latest) return false;
  try {
    const rows = await db.execute<{ applied: boolean }>(sql`
      select exists (
        select 1 from drizzle.__drizzle_migrations
        where created_at = ${latest.folderMillis}::bigint
      ) as applied
    `);
    return rows[0]?.applied === true;
  } catch (error) {
    if (NO_MIGRATION_HISTORY.has(sqlState(error) ?? '')) return false;
    throw error;
  }
}
