import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
    // Postgres NOTICEs print raw to stderr and are not errors. Migrations emit
    // one on every restart, which buries genuine failures in container logs.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema, casing: 'snake_case' });

  return { db, sql };
}
