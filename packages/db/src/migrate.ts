import { runMigrationsWithLock } from './migrator.js';

/**
 * `pnpm db:migrate` (development and the CI end-to-end job). The same
 * migrator as the API and its migrate job: under the migration advisory lock,
 * with MIGRATION_LOCK_TIMEOUT_MS and MIGRATION_STATEMENT_TIMEOUT_MS applied to
 * every statement and lock timeouts retried with backoff.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  console.log('Running migrations...');
  await runMigrationsWithLock(connectionString);
  console.log('Migrations complete.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
