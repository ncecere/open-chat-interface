import { serve } from '@hono/node-server';
import { migrationsApplied, runMigrationsWithLock, seedDatabase } from '@oci/db';
import { createApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { db } from './db/index.js';
import { logger } from './lib/logger.js';
import { startLifecycleJobs, stopJobs } from './services/jobs/index.js';
import { initTracing, shutdownTracing } from './services/observability/tracing.js';
import { purgeExpiredTemporaryThreads } from './services/threads.js';

async function main() {
  const env = loadEnv();

  // Loads the OpenTelemetry SDK only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
  await initTracing().catch((error) =>
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to start tracing; continuing without it',
    ),
  );

  /**
   * A container deployment has no separate migration step, so a fresh stack
   * would otherwise start against an empty database and crash-loop on the
   * first query. The advisory lock makes this safe when several replicas boot
   * together, and every operation here is idempotent.
   *
   * Operators running a dedicated migration job set RUN_MIGRATIONS=false, in
   * which case the process requires the latest bundled migration to be recorded
   * rather than serving a missing/stale schema and failing on an arbitrary query.
   */
  if (env.RUN_MIGRATIONS) {
    logger.info('Applying database migrations');
    await runMigrationsWithLock(env.DATABASE_URL);
    await seedDatabase(db);
  } else if (!(await migrationsApplied(db))) {
    throw new Error(
      'RUN_MIGRATIONS is false but the latest required database migration is not recorded. Run `pnpm db:migrate` first.',
    );
  }

  await ensureInitialAdmin();
  await purgeExpiredTemporaryThreads().catch((error) =>
    logger.error({ error }, 'Failed to purge expired temporary chats at startup'),
  );

  /**
   * Maintenance runs on interval timers guarded by per-job advisory locks.
   * Every replica ticks, but only the one that wins a job's lock performs it,
   * so cleanup with side effects cannot run N times concurrently.
   */
  startLifecycleJobs();

  const app = createApp();

  const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info(`API listening on http://localhost:${info.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    server.close(() => {
      void shutdownTracing().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  // Serialize the message explicitly: pino renders a bare Error as {} under
  // the `error` key, which hides the reason an operator needs.
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    'Failed to start API',
  );
  process.exit(1);
});
