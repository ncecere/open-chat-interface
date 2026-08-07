import { createDatabase } from '@oci/db';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const { db, sql } = createDatabase(env.DATABASE_URL);

export { schema } from '@oci/db';
export { db, sql };
