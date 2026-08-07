import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** Applies the committed migrations, so tests exercise the real schema. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
