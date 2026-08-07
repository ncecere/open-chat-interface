import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const { db, sql } = createDatabase(connectionString, { max: 1 });

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');

  await sql.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
