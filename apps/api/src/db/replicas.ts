import type postgres from 'postgres';
import { logger } from '../lib/logger.js';
import { openControlClient } from './control.js';
import { sql } from './index.js';

/**
 * How many OCI processes share this database, from PostgreSQL alone (v0.11
 * design, item 16): every OCI connection is named `oci:<role>:<id>@<host>`
 * (lib/instance.ts), so the distinct ids among the database's connections
 * are the replicas (and workers) running now. Redis heartbeats list replicas
 * too (services/jobs/workers.ts); this is for when Redis is not configured,
 * which is exactly when it matters.
 *
 * Visible to the application's own role (sessions of other roles show no
 * name without `pg_read_all_stats`). Behind a transaction-mode pooler the
 * server connections carry the name of the client that used them last, so
 * each replica also keeps one control connection open without Redis
 * (`startDatabasePresence`).
 */
export async function databaseReplicaCount(): Promise<number | null> {
  try {
    const rows = await sql<{ name: string }[]>`
      select distinct application_name as name from pg_stat_activity
      where datname = current_database() and application_name like 'oci:%'
    `;
    const ids = new Set(
      rows.map((row) => /^oci:[a-z]+:([^@]+)/.exec(row.name)?.[1]).filter(Boolean),
    );
    return ids.size;
  } catch {
    // Not knowing is not an error worth a log line on every health check.
    return null;
  }
}

/**
 * Keeps one named control connection open (and checks it every minute), so
 * this replica is counted by `databaseReplicaCount` even behind a pooler.
 */
export function startDatabasePresence(): () => Promise<void> {
  let client: postgres.Sql | null = openControlClient();
  const touch = () =>
    client
      ? client`select 1`.catch((error: unknown) =>
          logger.debug({ err: String(error) }, 'Replica presence check failed'),
        )
      : undefined;
  void touch();
  const timer = setInterval(() => void touch(), 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    const closing = client;
    client = null;
    await closing?.end({ timeout: 1 }).catch(() => undefined);
  };
}
