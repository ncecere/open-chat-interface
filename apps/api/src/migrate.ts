import { runMigrationsWithLock, runPostMigrations, seedDatabase } from '@oci/db';
import { loadEnv } from './config/env.js';
import { db } from './db/index.js';
import { logger } from './lib/logger.js';

/**
 * Standalone schema migration for deployments that scale the API.
 *
 * Running this as its own job lets every replica boot with
 * `RUN_MIGRATIONS=false`, so schema changes happen exactly once and in a known
 * order rather than racing at startup. The advisory lock still applies, so
 * running it concurrently with a booting API is safe.
 *
 * `node dist/migrate.js --post` is the post-deploy phase (v0.11 design,
 * section 1): run it once every replica runs the new release. It applies the
 * release's post-deploy steps (concurrent index builds, validations, drops)
 * outside a transaction and schedules its background migrations, which the
 * replicas' job runner then works through. It refuses to run until every
 * pre-deploy migration of the release is applied.
 */
async function main() {
  const env = loadEnv();

  if (process.argv.includes('--post')) {
    logger.info('Applying post-deploy steps');
    const result = await runPostMigrations(env.DATABASE_URL, { logger });
    logger.info(
      {
        steps: result.steps.map((step) => ({
          name: step.name,
          outcome: step.outcome,
          durationMs: step.durationMs,
          rebuiltInvalidIndex: step.rebuiltInvalidIndex,
        })),
        scheduled: result.scheduled,
      },
      'Post-deploy steps complete',
    );
    return;
  }

  logger.info('Applying database migrations');
  await runMigrationsWithLock(env.DATABASE_URL, { logger });

  logger.info('Seeding default instance settings');
  await seedDatabase(db);

  logger.info('Migration complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // The message, not the object: pino renders a bare Error as {}.
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Migration failed',
    );
    process.exit(1);
  });
