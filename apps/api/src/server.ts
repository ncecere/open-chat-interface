import { serve } from '@hono/node-server';
import { migrationsApplied, runMigrationsWithLock, seedDatabase } from '@oci/db';
import { createApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { db } from './db/index.js';
import { logger } from './lib/logger.js';
import { sweepAbandonedReservations } from './services/quota/index.js';
import { purgeExpiredTemporaryThreads } from './services/threads.js';

async function main() {
  const env = loadEnv();

  /**
   * A container deployment has no separate migration step, so a fresh stack
   * would otherwise start against an empty database and crash-loop on the
   * first query. The advisory lock makes this safe when several replicas boot
   * together, and every operation here is idempotent.
   *
   * Operators running a dedicated migration job set RUN_MIGRATIONS=false, in
   * which case the process refuses to serve against a schema that is missing
   * rather than failing later on an arbitrary query.
   */
  if (env.RUN_MIGRATIONS) {
    logger.info('Applying database migrations');
    await runMigrationsWithLock(env.DATABASE_URL);
    await seedDatabase(db);
  } else if (!(await migrationsApplied(db))) {
    throw new Error(
      'RUN_MIGRATIONS is false but the database has no schema. Run `pnpm db:migrate` first.',
    );
  }

  await ensureInitialAdmin();
  await purgeExpiredTemporaryThreads();

  // Backstop the opportunistic request-time cleanup so expired temporary
  // conversations disappear even on otherwise idle instances.
  const temporaryCleanup = setInterval(
    () => {
      void purgeExpiredTemporaryThreads().catch((error) =>
        logger.error({ error }, 'Failed to purge expired temporary chats'),
      );
    },
    60 * 60 * 1000,
  );
  temporaryCleanup.unref();

  // A process that dies mid-stream never settles its quota reservation. Those
  // rows already stop counting at the TTL; this keeps them from lingering.
  const reservationSweep = setInterval(
    () => {
      void sweepAbandonedReservations().catch((error) =>
        logger.error({ error }, 'Failed to sweep abandoned quota reservations'),
      );
    },
    5 * 60 * 1000,
  );
  reservationSweep.unref();

  const app = createApp();

  const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info(`API listening on http://localhost:${info.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
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
