// First: sizes libuv's thread pool (password hashing) before anything uses it.
import './lib/threadpool.js';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { migrationsApplied, runMigrationsWithLock, seedDatabase } from '@oci/db';
import { createApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { controlDatabaseUrl } from './db/control.js';
import { db, sql } from './db/index.js';
import { closeReadReplica } from './db/read.js';
import { startDatabasePresence } from './db/replicas.js';
import {
  chatTurnsBeingAdmitted,
  closeConnectionsWhileDraining,
  createShutdown,
  withDrain,
} from './lib/drain.js';
import { logger } from './lib/logger.js';
import { watchRedisRequirement } from './lib/redis-requirement.js';
import { processRole } from './lib/role.js';
import { withReadRetry } from './middleware/read-retry.js';
import { startCacheBus } from './services/cache-bus/index.js';
import { activeRunCount, interruptActiveRuns } from './services/chat/active-runs.js';
import {
  chatReplayCount,
  closeChatStreams,
  endChatReplays,
  redisConfigured,
} from './services/chat-streams.js';
import { startCiphertextFormatWatch } from './services/encryption/rotation.js';
import { runningJobCount, startLifecycleJobs, stopJobs } from './services/jobs/index.js';
import { startReplicaHeartbeat, watchForWorkers } from './services/jobs/workers.js';
import { initTracing, shutdownTracing } from './services/observability/tracing.js';
import { purgeExpiredTemporaryThreads } from './services/threads.js';
import { createWorkerApp } from './worker-app.js';

/**
 * How long a shutdown of an `all` replica waits for a background job already
 * running. Jobs are safe to re-run, so one still going after this (a backup,
 * say) is left to the next tick on another replica rather than holding the
 * drain open; replies come first on a replica that serves them. A worker
 * gives its jobs the whole drain limit instead (SHUTDOWN_DRAIN_TIMEOUT_MS).
 */
const JOB_DRAIN_MS = 5_000;

async function main() {
  const env = loadEnv();
  const role = processRole();
  const runsJobs = role !== 'web';

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
    await runMigrationsWithLock(controlDatabaseUrl(), { logger });
    await seedDatabase(db);
  } else if (!(await migrationsApplied(db))) {
    throw new Error(
      'RUN_MIGRATIONS is false but the latest required database migration is not recorded. Run `pnpm db:migrate` first.',
    );
  }

  await ensureInitialAdmin();
  // Stored secrets: the versioned ciphertext format once no v0.10 replica
  // can be running (v0.11 design, item 23; services/encryption/rotation.ts).
  const stopCiphertextWatch = await startCiphertextFormatWatch();

  // Settings and other per-replica caches are cleared on every replica when
  // one changes them, over Redis (v0.11 item 20); on every role, since a
  // worker reads the read-only switch to pause its jobs. Without Redis they
  // expire on their own (30 s for settings).
  const stopCacheBus = await startCacheBus();

  /**
   * Maintenance runs on interval timers guarded by per-job advisory locks.
   * Every replica that runs jobs (OCI_ROLE=worker or all) ticks, but only the
   * one that wins a job's lock performs it, so cleanup with side effects
   * cannot run N times concurrently. A `web` replica runs none and asks a
   * worker for work its requests start (services/jobs/requests.ts).
   */
  if (runsJobs) {
    await purgeExpiredTemporaryThreads().catch((error) =>
      logger.error({ error }, 'Failed to purge expired temporary chats at startup'),
    );
    await startLifecycleJobs();
  }
  const stopHeartbeat = startReplicaHeartbeat(role);
  const stopWatchingWorkers = role === 'web' ? watchForWorkers() : () => {};
  // Redis is required for more than one replica (v0.11 design, item 16).
  // Without it, each replica keeps a named connection open so the others can
  // count it, and warns when they are not alone.
  if (!redisConfigured())
    logger.warn(
      'Redis is not configured: supported for a single replica only (rate limits, concurrency caps and resumable replies are per replica)',
    );
  const stopPresence = redisConfigured() ? async () => {} : startDatabasePresence();
  const stopWatchingRedis = watchRedisRequirement();

  // A worker serves health and metrics only (worker-app.ts).
  const app = role === 'worker' ? createWorkerApp() : createApp();

  const fetch = withDrain(withReadRetry(app.fetch));
  const server = serve({ fetch, port: env.API_PORT }, (info) => {
    logger.info(
      { role },
      role === 'worker'
        ? `Worker running background jobs; health and metrics on http://localhost:${info.port}`
        : `API listening on http://localhost:${info.port}`,
    );
  }) as Server;
  // Keep idle connections open longer than a proxy keeps them in its pool
  // (the bundled Caddy: 30 s; most load balancers: 60 s). Otherwise the API
  // can close one just as the proxy sends a request on it, which the proxy
  // answers with 502 for anything but GET.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  closeConnectionsWhileDraining(server);

  const jobsUntil = { at: Number.POSITIVE_INFINITY };
  const shutdown = createShutdown({
    server,
    drainTimeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
    stopIntake: () => {
      stopJobs();
      stopWatchingWorkers();
      stopWatchingRedis();
      stopCiphertextWatch();
      void stopHeartbeat();
      // Jobs stop at their next check between batches (jobMayContinue).
      jobsUntil.at =
        Date.now() + (role === 'worker' ? env.SHUTDOWN_DRAIN_TIMEOUT_MS : JOB_DRAIN_MS);
    },
    workInProgress: () =>
      activeRunCount() +
      chatTurnsBeingAdmitted() +
      (Date.now() < jobsUntil.at ? runningJobCount() : 0),
    interruptWork: interruptActiveRuns,
    openStreams: chatReplayCount,
    endStreams: endChatReplays,
    closeResources: async () => {
      await Promise.allSettled([
        closeChatStreams(),
        stopCacheBus(),
        sql.end({ timeout: 5 }),
        closeReadReplica(),
        stopPresence(),
        shutdownTracing(),
      ]);
    },
    exit: (code) => process.exit(code),
    log: logger,
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
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
