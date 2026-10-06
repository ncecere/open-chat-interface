import { createControlClient } from '@oci/db';
import { loadEnv } from '../config/env.js';
import { databaseApplicationName } from '../lib/instance.js';
import { processRole } from '../lib/role.js';

/**
 * Control connections (v0.11 design, section 11; docs/OPERATIONS.md,
 * "Connection pooling").
 *
 * The application pool (db/index.ts) may sit behind a transaction-mode
 * pooler, where one client's consecutive statements can run on different
 * server connections. Everything that needs a PostgreSQL session of its own
 * opens a short-lived control connection to `CONTROL_DATABASE_URL` (direct,
 * or a session-mode pooler) instead. The complete list, which is what a
 * replica may hold at once:
 *
 * | Use | Connections | Where |
 * | --- | --- | --- |
 * | A running background job's advisory lock | 1 per job running | services/jobs/lock.ts |
 * | `LISTEN` for work asked of a worker | 1 per worker/all replica | services/jobs/requests.ts |
 * | `LISTEN` for a worker to take a manual run (#265) | 1 per run, for up to 5 s | services/jobs/requests.ts |
 * | Pre-deploy migrations (startup or `migrate`) | 1, plus 1 lock monitor | packages/db migrator |
 * | Post-deploy steps (`migrate --post`, or the job) | 1, plus 1 lock monitor | packages/db post-migrator |
 * | `pg_dump` for a backup | 1 while it runs | services/backups/run.ts |
 * | Presence, without Redis | 1 | db/replicas.ts |
 *
 * Transaction-scoped work stays on the application pool: `pg_advisory_xact_lock`,
 * `set_config(..., true)` (SET LOCAL) and `NOTIFY` all end with their
 * transaction, which a transaction-mode pooler keeps on one server connection.
 */
export function controlDatabaseUrl(): string {
  const env = loadEnv();
  return env.CONTROL_DATABASE_URL ?? env.DATABASE_URL;
}

/** A new control client; the caller ends it. */
export function openControlClient(options: { max?: number } = {}) {
  return createControlClient(controlDatabaseUrl(), {
    max: options.max ?? 1,
    applicationName: databaseApplicationName(processRole()),
  });
}
