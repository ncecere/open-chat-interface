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
}

/**
 * Seconds to wait for a new connection. postgres.js waits 30 s by default;
 * during a failover the proxy or virtual IP either answers quickly or not at
 * all, and a request should fail (and be retried by its caller) well before
 * a client or load balancer gives up on it.
 */
const CONNECT_TIMEOUT_SECONDS = 10;

/**
 * postgres.js reconnects on its own: a connection that drops is discarded and
 * the next query opens a new one, so after a failover the pool recovers
 * without a restart. A query in flight, or a transaction open, on a dropped
 * connection fails with the connection error rather than hanging (see
 * patches/postgres@3.4.9.patch for the case where it used to throw outside
 * any promise instead).
 */
export function createDatabase(connectionString: string, options?: DatabaseOptions) {
  const onConnectionClosed = options?.onConnectionClosed;
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    // Postgres NOTICEs print raw to stderr and are not errors. Migrations emit
    // one on every restart, which buries genuine failures in container logs.
    onnotice: () => {},
    ...(onConnectionClosed ? { onclose: () => onConnectionClosed() } : {}),
  });

  const db = drizzle(sql, { schema, casing: 'snake_case' });

  return { db, sql };
}
