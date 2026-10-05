import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ProcessRole } from './role.js';

/** This process, among every replica: host, process and a random suffix. */
export const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** The random part alone: unique enough to tell replicas apart, short enough for PostgreSQL. */
const shortId = instanceId.slice(instanceId.lastIndexOf(':') + 1);

/**
 * `application_name` for this process's PostgreSQL connections, shown in
 * `pg_stat_activity`: `oci:<role>:<id>@<host>`, cut to PostgreSQL's 63
 * bytes. Counting the distinct ids there tells how many replicas share the
 * database even without Redis (db/replicas.ts).
 */
export function databaseApplicationName(role: ProcessRole): string {
  return `oci:${role}:${shortId}@${hostname()}`.slice(0, 63);
}
