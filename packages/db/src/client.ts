import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(connectionString: string, options?: { max?: number }) {
  const sql = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
  });

  const db = drizzle(sql, { schema, casing: 'snake_case' });

  return { db, sql };
}
