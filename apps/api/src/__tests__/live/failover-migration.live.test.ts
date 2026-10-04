import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrationsWithLock, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  controlConnection,
  terminateEveryBackend,
  waitForStatement,
} from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * A database failover in the middle of a pre-deploy migration (v0.11 design,
 * section 3), driven through the real migrator. Every backend is terminated
 * while a migration is half applied: the attempt must fail promptly with the
 * connection error (not hang), leave nothing of itself behind (one
 * transaction, so the failover rolls it back, advisory lock included), and a
 * rerun must start from the beginning and apply everything cleanly.
 */
const available = await livePostgresAvailable();

function migrationsFolder(statements: string[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'oci-failover-migrations-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, '0000_failover.sql'), statements.join('\n--> statement-breakpoint\n'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1_900_000_000_000, tag: '0000_failover', breakpoints: true },
      ],
    }),
  );
  return folder;
}

describe.skipIf(!available)('live failover during a pre-deploy migration', () => {
  let live: LiveDatabase;
  let folder: string;

  beforeAll(async () => {
    live = await createLiveDatabase('failover_migration');
    // Only this throwaway database: start from an empty schema and journal.
    await live.db.execute(sql`drop schema public cascade`);
    await live.db.execute(sql`drop schema drizzle cascade`);
    await live.db.execute(sql`create schema public`);
    folder = migrationsFolder([
      'create table failover_first (id integer primary key)',
      'insert into failover_first values (1), (2), (3)',
      // The failover lands here, with the first table created and filled.
      "select pg_sleep(case when exists (select 1 from pg_class where relname = 'failover_marker') then 0 else 30 end)",
      'create table failover_second (id integer primary key)',
    ]);
  });
  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await live?.destroy();
  });

  it('rolls the attempt back when every connection drops, and a rerun applies it cleanly', async () => {
    const control = controlConnection(live.connectionString);
    try {
      const started = Date.now();
      const attempt = runMigrationsWithLock(live.connectionString, {
        migrationsFolder: folder,
        maxAttempts: 1,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForStatement(control, '%pg_sleep%');
      expect(await terminateEveryBackend(control)).toBeGreaterThanOrEqual(1);

      const error = (await attempt) as { code?: string } | null;
      // A connection error, promptly: not a hang until the sleep ends.
      expect(error).not.toBeNull();
      expect(['57P01', 'CONNECTION_CLOSED']).toContain(error?.code);
      expect(Date.now() - started).toBeLessThan(20_000);

      // Nothing of the attempt survived: no table, no journal row, no lock.
      const [state] = await control<
        { first: string | null; journal: string | null; locks: number }[]
      >`
        select to_regclass('public.failover_first')::text as first,
          to_regclass('drizzle.__drizzle_migrations')::text as journal,
          (select count(*)::int from pg_locks where locktype = 'advisory'
            and database = (select oid from pg_database where datname = current_database())) as locks
      `;
      expect(state).toEqual({ first: null, journal: null, locks: 0 });

      // The rerun (an orchestrator restarting the migrate job) starts cleanly.
      await control`create table failover_marker (id integer)`;
      await expect(
        runMigrationsWithLock(live.connectionString, { migrationsFolder: folder, maxAttempts: 1 }),
      ).resolves.toEqual({ applied: true });
      const [after] = await control<{ rows: number; second: string | null; applied: number }[]>`
        select (select count(*)::int from failover_first) as rows,
          to_regclass('public.failover_second')::text as second,
          (select count(*)::int from drizzle.__drizzle_migrations) as applied
      `;
      expect(after).toEqual({ rows: 3, second: 'failover_second', applied: 1 });
    } finally {
      await control.end({ timeout: 1 });
    }
  }, 60_000);
});
