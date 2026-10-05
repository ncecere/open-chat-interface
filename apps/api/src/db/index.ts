import { createDatabase } from '@oci/db';
import { loadEnv } from '../config/env.js';
import { noteConnectionClosed } from '../lib/db-connection.js';
import { databaseApplicationName } from '../lib/instance.js';
import { processRole } from '../lib/role.js';
import { routedDatabase } from './routing.js';

const env = loadEnv();

/**
 * The application pool (v0.11 design, section 11): every request and every
 * job body. Safe behind a transaction-mode pooler (PgBouncer), so nothing on
 * it may keep session state between transactions; what needs a session of its
 * own (advisory locks held across transactions, LISTEN, session settings,
 * migrations, pg_dump) uses a control connection (db/control.ts). Heavy
 * administrative reads may go to a replica instead (db/read.ts).
 *
 * A lost connection is counted, so a read that failed while one dropped under
 * it can be retried (middleware/read-retry.ts).
 */
const primary = createDatabase(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  applicationName: databaseApplicationName(processRole()),
  onConnectionClosed: noteConnectionClosed,
});

/** The primary, or the read replica inside `onReadReplica` (db/read.ts). */
const db = routedDatabase(primary.db);
/** The application pool's raw client: always the primary. */
const sql = primary.sql;

export { schema } from '@oci/db';
export { db, sql };
