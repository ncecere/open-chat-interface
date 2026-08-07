import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { sweepAbandonedReservations } from './services/quota/index.js';
import { purgeExpiredTemporaryThreads } from './services/threads.js';

async function main() {
  const env = loadEnv();

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
  logger.error({ error }, 'Failed to start API');
  process.exit(1);
});
