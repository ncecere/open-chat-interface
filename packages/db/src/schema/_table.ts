import { pgTableCreator } from 'drizzle-orm/pg-core';

/**
 * All OCI tables are created through this helper so a table prefix can be
 * introduced later without touching every schema file.
 */
export const pgTable = pgTableCreator((name) => name);
