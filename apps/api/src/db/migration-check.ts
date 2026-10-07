import { type Database, migrationsApplied } from '@oci/db';
import {
  isConnectionError,
  type RetryOptions,
  retryOnConnectionError,
} from '../lib/db-connection.js';
import { logger } from '../lib/logger.js';

/**
 * How long a replica started with RUN_MIGRATIONS=false waits for an
 * unreachable database before giving up: long enough to ride out a restart
 * or failover (the worker in #137 restarted six times while PostgreSQL was
 * down for 15 s), short enough that a wrong DATABASE_URL still fails soon.
 */
export const migrationCheckRetry: RetryOptions = { budgetMs: 30_000, initialDelayMs: 500 };

/**
 * Requires the latest bundled migration to be recorded before a replica serves
 * without migrating. A database it cannot reach is reported as that, not as a
 * missing migration (#137).
 */
export async function requireMigrationsRecorded(
  db: Database,
  retry: RetryOptions = migrationCheckRetry,
): Promise<void> {
  let applied: boolean;
  try {
    applied = await retryOnConnectionError(() => migrationsApplied(db), {
      ...retry,
      onRetry: ({ attempt, delayMs, error }) =>
        logger.warn(
          { attempt, delayMs, err: error instanceof Error ? error.message : String(error) },
          'The database is unreachable; waiting for it before checking its migrations',
        ),
    });
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the database to check its migrations (${reason}). Check that PostgreSQL is running and DATABASE_URL points at it.`,
      { cause: error },
    );
  }
  if (!applied)
    throw new Error(
      'RUN_MIGRATIONS is false but the latest required database migration is not recorded. Run `pnpm db:migrate` first.',
    );
}
