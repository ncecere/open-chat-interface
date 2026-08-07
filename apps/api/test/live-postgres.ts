import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, runMigrations, sql } from '@oci/db';
import postgres from 'postgres';

/**
 * Where live tests find Postgres. `TEST_DATABASE_URL` lets CI point at its own
 * server; otherwise the local development database from `pnpm infra:up` is
 * used. Only the connection is borrowed — every test creates and drops its own
 * throwaway database, so development data is never touched.
 */
function adminConnectionString(): string | null {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

async function serverReachable(connectionString: string): Promise<boolean> {
  const client = postgres(connectionString, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * True when a real Postgres is reachable. Suites call this to skip rather than
 * fail, so `pnpm test` still passes on a machine with no database running.
 */
export async function livePostgresAvailable(): Promise<boolean> {
  const connectionString = adminConnectionString();
  return connectionString ? serverReachable(connectionString) : false;
}

export interface LiveDatabase {
  db: Database;
  /** Needed by suites that open their own connection, such as migration locks. */
  connectionString: string;
  /** Drops the throwaway database. Always call from `afterAll`. */
  destroy: () => Promise<void>;
}

/**
 * Creates an isolated database, applies the real migrations, and returns a
 * client for it. Running actual migrations is the point: mocked query chains
 * cannot catch a broken migration, a missing constraint, or SQL that Drizzle
 * generates differently than expected.
 */
export async function createLiveDatabase(label: string): Promise<LiveDatabase> {
  const adminUrl = adminConnectionString();
  if (!adminUrl) throw new Error('No database connection string configured');

  const name = `oci_test_${label}_${randomUUID().slice(0, 8)}`.toLowerCase();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });

  try {
    // Identifiers cannot be parameterized; the name is generated, not user input.
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;

  const { db, sql: client } = createDatabase(testUrl.toString(), { max: 1 });
  await runMigrations(db);

  return {
    db,
    connectionString: testUrl.toString(),
    destroy: async () => {
      await client.end({ timeout: 5 }).catch(() => {});
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 }).catch(() => {});
      }
    },
  };
}

/** Seeds the single organization every other row depends on. */
export async function seedOrganization(db: Database): Promise<string> {
  const [row] = await db.execute<{ id: string }>(
    sql`insert into organization (name, slug) values ('Test', 'test') returning id`,
  );
  if (!row) throw new Error('Failed to seed organization');
  return row.id;
}

/** Seeds a user, returning its id for ownership and quota assertions. */
export async function seedUser(
  db: Database,
  organizationId: string,
  overrides: { email?: string; role?: string } = {},
): Promise<string> {
  const email = overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.com`;
  const role = overrides.role ?? 'user';

  // Better Auth generates user ids, so the column carries no database default.
  const id = randomUUID();

  const [row] = await db.execute<{ id: string }>(
    sql`insert into "user" (id, name, email, email_verified, role, organization_id)
        values (${id}, 'Test User', ${email}, true, ${role}, ${organizationId})
        returning id`,
  );
  if (!row) throw new Error('Failed to seed user');
  return row.id;
}

/** True when the named container is running, so suites can skip cleanly. */
export function containerRunning(name: string): boolean {
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--filter', `name=${name}`, '--format', '{{.Names}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return out.includes(name);
  } catch {
    return false;
  }
}
