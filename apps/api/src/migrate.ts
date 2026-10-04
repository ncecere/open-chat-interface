import { runMigrationsWithLock, seedDatabase } from '@oci/db';
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
 */
async function main() {
  const env = loadEnv();

  logger.info('Applying database migrations');
  await runMigrationsWithLock(env.DATABASE_URL, { logger });

  logger.info('Seeding default instance settings');
  await seedDatabase(db);

  logger.info('Migration complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  });
