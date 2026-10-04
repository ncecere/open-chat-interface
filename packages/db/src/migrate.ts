import { runMigrationsWithLock } from './migrator.js';
import { runPostMigrations } from './post-migrator.js';

/**
 * `pnpm db:migrate` (development and the CI end-to-end job). The same
 * migrator as the API and its migrate job: under the migration advisory lock,
 * with MIGRATION_LOCK_TIMEOUT_MS and MIGRATION_STATEMENT_TIMEOUT_MS applied to
 * every statement and lock timeouts retried with backoff.
 *
 * `pnpm db:migrate --post` applies the post-deploy steps instead and
 * schedules background migrations (docs/dev/database.md).
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  if (process.argv.includes('--post')) {
    console.log('Running post-deploy steps...');
    const result = await runPostMigrations(connectionString);
    const applied = result.steps.filter((step) => step.outcome === 'applied');
    console.log(
      `Post-deploy steps complete: ${applied.length} applied, ${result.steps.length - applied.length} already done.`,
    );
    return;
  }

  console.log('Running migrations...');
  await runMigrationsWithLock(connectionString);
  console.log('Migrations complete.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
