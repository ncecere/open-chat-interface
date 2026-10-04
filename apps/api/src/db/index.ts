import { createDatabase } from '@oci/db';
import { loadEnv } from '../config/env.js';
import { noteConnectionClosed } from '../lib/db-connection.js';

const env = loadEnv();

// A lost connection is counted, so a read that failed while one dropped under
// it can be retried (middleware/read-retry.ts).
const { db, sql } = createDatabase(env.DATABASE_URL, { onConnectionClosed: noteConnectionClosed });

export { schema } from '@oci/db';
export { db, sql };
