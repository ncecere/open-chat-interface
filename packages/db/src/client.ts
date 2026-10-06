import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export interface DatabaseOptions {
  max?: number;
  /**
   * Called whenever one of the pool's connections closes, for whatever
   * reason. A failover closes all of them at once (v0.11 design, section 3).
   */
  onConnectionClosed?: () => void;
  /** Shown in `pg_stat_activity` (and by poolers), so each process's connections can be told apart. */
  applicationName?: string;
}

/**
 * Seconds to wait for a new connection. postgres.js waits 30 s by default;
 * during a failover the proxy or virtual IP either answers quickly or not at
 * all, and a request should fail (and be retried by its caller) well before
 * a client or load balancer gives up on it.
 */
const CONNECT_TIMEOUT_SECONDS = 10;

/** The longest wait, in seconds, before a pooled connection that failed tries again. */
const MAX_RECONNECT_DELAY_SECONDS = 2;

/**
 * Seconds a connection waits before trying to connect again after a failed
 * attempt: postgres.js's own curve (`3^n / 100` s with jitter, n counting
 * failures since the pool last connected), but capped at 2 s instead of 20.
 * The count is shared by the whole pool and only reset by a connection that
 * succeeds, so a database away for half a minute pushed every attempt to a
 * 10-20 s wait: requests that would fail at once (the name does not resolve,
 * the port refuses) took 12-16 s to answer, and once the database was back
 * the first requests still waited out that delay before connecting. The
 * attempts only happen while queries are waiting, at most one per pooled
 * connection every 1-2 s, which a database that is down or failing over
 * absorbs easily.
 */
export function reconnectDelaySeconds(failures: number): number {
  return (0.5 + Math.random() / 2) * Math.min(3 ** failures / 100, MAX_RECONNECT_DELAY_SECONDS);
}

/**
 * postgres.js reconnects on its own: a connection that drops is discarded and
 * the next query opens a new one, so after a failover the pool recovers
 * without a restart. A query in flight, or a transaction open, on a dropped
 * connection fails with the connection error rather than hanging (see
 * patches/postgres@3.4.9.patch for the case where it used to throw outside
 * any promise instead).
 *
 * Safe behind a transaction-mode pooler such as PgBouncer (v0.11 design,
 * section 11): prepared statements are off, and nothing that uses a pool
 * made here may leave state on its connection after a transaction ends: no
 * `SET` without `LOCAL` (or `set_config(..., false)`), no session advisory
 * locks, no `LISTEN`, no temporary tables, no `reserve()`. Those belong on a
 * control connection (`createControlClient`).
 */
export function createDatabase(connectionString: string, options?: DatabaseOptions) {
  const onConnectionClosed = options?.onConnectionClosed;
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    backoff: reconnectDelaySeconds,
    // Postgres NOTICEs print raw to stderr and are not errors. Migrations emit
    // one on every restart, which buries genuine failures in container logs.
    onnotice: () => {},
    ...(options?.applicationName
      ? { connection: { application_name: options.applicationName } }
      : {}),
    ...(onConnectionClosed ? { onclose: () => onConnectionClosed() } : {}),
  });

  const db = drizzle(sql, { schema, casing: 'snake_case' });

  return { db, sql };
}

/**
 * A client for work that needs one PostgreSQL session to itself (v0.11
 * design, section 11): session advisory locks, `LISTEN`, session settings,
 * `CREATE INDEX CONCURRENTLY` steps. Give it a direct connection string or one
 * through a session-mode pooler (`CONTROL_DATABASE_URL`), never a
 * transaction-mode pooler: there, consecutive statements of one client may
 * run on different server connections, so a lock or setting lands on a
 * connection someone else uses next. The caller ends it.
 */
export function createControlClient(
  connectionString: string,
  options: { max?: number; applicationName?: string } = {},
) {
  return postgres(connectionString, {
    max: options.max ?? 1,
    prepare: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    backoff: reconnectDelaySeconds,
    onnotice: () => {},
    ...(options.applicationName
      ? { connection: { application_name: options.applicationName } }
      : {}),
  });
}
