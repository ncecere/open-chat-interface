import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type MigrationRetryEvent, runMigrationsWithLock, sql } from '@oci/db';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * v0.11 lock-safe migrations (design section 2). A migration that needs a lock
 * another session holds must not wait indefinitely: while it waits, PostgreSQL
 * queues every later request for that table behind it, so one long transaction
 * plus one ALTER TABLE stops all reads of the table. Each attempt now gives up
 * after lock_timeout, rolls back, and retries with backoff.
 *
 * Test-only migration folders hold the subject migrations; the real migrations
 * are already applied by the fixture and are never modified.
 */

const available = await livePostgresAvailable();

// Far beyond any real migration's `when`, so Drizzle treats these as pending.
const TEST_MIGRATION_WHEN = 4_000_000_000_000;

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error && current.cause) current = current.cause;
  return current;
}

describe.skipIf(!available)('live PostgreSQL lock-safe migrations', () => {
  let live: LiveDatabase | undefined;
  let folders: string[] = [];
  let clients: postgres.Sql[] = [];

  beforeEach(async () => {
    live = await createLiveDatabase('migration_lock_timeout');
    await live.db.execute(sql`create table lock_probe (id integer primary key)`);
    await live.db.execute(sql`insert into lock_probe values (1), (2)`);
  });

  afterEach(async () => {
    for (const client of clients) await client.end({ timeout: 1 }).catch(() => {});
    clients = [];
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
    folders = [];
    const owned = live;
    live = undefined;
    await owned?.destroy();
  });

  /** Writes a one-migration Drizzle folder whose statements are split by breakpoints. */
  async function migrationFolder(tag: string, statements: string[]): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'oci-migration-lock-'));
    folders.push(folder);
    await mkdir(join(folder, 'meta'));
    const journal = {
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: TEST_MIGRATION_WHEN, tag, breakpoints: true }],
    };
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    await writeFile(join(folder, `${tag}.sql`), statements.join('\n--> statement-breakpoint\n'));
    return folder;
  }

  function client(): postgres.Sql {
    const created = postgres(live!.connectionString, { max: 1, onnotice: () => {} });
    clients.push(created);
    return created;
  }

  /** An open transaction holding ACCESS SHARE on lock_probe, as a long report or pg_dump would. */
  async function holdAccessShare() {
    const reserved = await client().reserve();
    const [row] = await reserved<[{ pid: number }]>`select pg_backend_pid() as pid`;
    await reserved`begin`;
    await reserved`select count(*) from lock_probe`;
    return {
      pid: row!.pid,
      commit: async () => {
        await reserved`commit`;
        reserved.release();
      },
      rollback: async () => {
        await reserved`rollback`;
        reserved.release();
      },
    };
  }

  async function migrationWaitingForProbe(): Promise<boolean> {
    const [row] = await live!.db.execute<{ waiting: number }>(sql`
      select count(*)::integer as waiting
      from pg_locks l join pg_class c on c.oid = l.relation
      where c.relname = 'lock_probe' and not l.granted and l.mode = 'AccessExclusiveLock'
    `);
    return row!.waiting > 0;
  }

  async function probeColumns(): Promise<string[]> {
    const rows = await live!.db.execute<{ name: string }>(sql`
      select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'lock_probe' order by ordinal_position
    `);
    return rows.map((row) => row.name);
  }

  async function journalRecorded(): Promise<boolean> {
    const [row] = await live!.db.execute<{ recorded: boolean }>(sql`
      select exists (
        select 1 from drizzle.__drizzle_migrations where created_at = ${TEST_MIGRATION_WHEN}::bigint
      ) as recorded
    `);
    return row!.recorded;
  }

  it('lets readers through after lock_timeout and retries until the blocker commits', async () => {
    const folder = await migrationFolder('9000_lock_probe_column', [
      'ALTER TABLE "lock_probe" ADD COLUMN "note" text',
    ]);
    const blocker = await holdAccessShare();
    const retries: MigrationRetryEvent[] = [];
    let committed = false;
    const migration = settle(
      runMigrationsWithLock(live!.connectionString, {
        migrationsFolder: folder,
        lockTimeoutMs: 1_000,
        retryDelayMs: 100,
        maxRetryDelayMs: 200,
        maxAttempts: 100,
        onRetry: (event) => retries.push(event),
      }),
    );
    const reader = client();
    try {
      // The ALTER is now queued for ACCESS EXCLUSIVE behind the open transaction.
      await vi.waitFor(async () => expect(await migrationWaitingForProbe()).toBe(true), {
        timeout: 5_000,
        interval: 25,
      });

      // An ordinary reader arriving now queues behind the waiting ALTER. Without
      // lock_timeout it would wait as long as the blocker does (indefinitely here).
      const started = Date.now();
      const read = reader`select count(*)::integer as n from lock_probe`.then((rows) => ({
        rows: rows[0]!.n,
        waitedMs: Date.now() - started,
      }));
      const outcome = await Promise.race([read, sleep(3_500).then(() => 'still blocked' as const)]);
      expect(outcome, 'a reader must not queue behind a blocked migration').not.toBe(
        'still blocked',
      );
      if (outcome === 'still blocked') return;
      expect(outcome.rows).toBe(2);
      // Blocked at most about one lock_timeout (1s) plus scheduling slack.
      expect(outcome.waitedMs).toBeLessThan(2_500);

      // The migration keeps retrying while the blocker remains, and reports it.
      await vi.waitFor(() => expect(retries.length).toBeGreaterThanOrEqual(2), {
        timeout: 10_000,
        interval: 25,
      });
      expect(retries[0]).toMatchObject({ attempt: 1, relation: 'public.lock_probe' });
      expect(retries[0]!.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ pid: blocker.pid })]),
      );
      expect(await probeColumns()).toEqual(['id']);

      await blocker.commit();
      committed = true;
      const result = await migration;
      expect(result).toEqual({ status: 'fulfilled', value: { applied: true } });
      expect(await probeColumns()).toEqual(['id', 'note']);
      expect(await journalRecorded()).toBe(true);
    } finally {
      if (!committed) await blocker.commit().catch(() => {});
      await migration;
    }
  }, 30_000);

  it('gives up after the attempt limit and names the relation and the blocking session', async () => {
    const folder = await migrationFolder('9000_lock_probe_column', [
      'CREATE TABLE "lock_probe_sibling" (id integer)',
      'ALTER TABLE "lock_probe" ADD COLUMN "note" text',
    ]);
    const blocker = await holdAccessShare();
    const retries: unknown[] = [];
    const started = Date.now();
    try {
      const result = await settle(
        runMigrationsWithLock(live!.connectionString, {
          migrationsFolder: folder,
          lockTimeoutMs: 300,
          retryDelayMs: 50,
          maxRetryDelayMs: 50,
          maxAttempts: 3,
          onRetry: (event) => retries.push(event),
        }),
      );
      expect(result.status).toBe('rejected');
      const error = (result as { error: Error }).error;
      expect(error.name).toBe('MigrationLockTimeoutError');
      expect(error.message).toContain('3 attempts');
      expect(error.message).toContain('public.lock_probe');
      expect(error.message).toContain('AccessExclusiveLock');
      expect(error.message).toContain(`pid ${blocker.pid}`);
      expect(error.message).toContain('select count(*) from lock_probe');
      expect(error.message).toContain('ALTER TABLE "lock_probe"');
      expect(rootCause(error)).toMatchObject({ code: '55P03' });
      expect(retries).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.rollback();
    }

    // Every attempt rolled back completely, including the earlier statement.
    expect(await probeColumns()).toEqual(['id']);
    const [sibling] = await live!.db.execute<{ name: string | null }>(
      sql`select to_regclass('public.lock_probe_sibling')::text as name`,
    );
    expect(sibling!.name).toBeNull();
    expect(await journalRecorded()).toBe(false);

    // The migrator's own connection and its lock monitor are both closed.
    const databaseName = new URL(live!.connectionString).pathname.slice(1);
    const fixturePids = new Set<number>();
    for (const owned of clients) {
      const [row] = await owned<[{ pid: number }]>`select pg_backend_pid() as pid`;
      fixturePids.add(row!.pid);
    }
    const [self] = await live!.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    fixturePids.add(self!.pid);
    await expect
      .poll(
        async () => {
          const rows = await live!.db.execute<{ pid: number }>(sql`
            select pid from pg_stat_activity
            where datname = ${databaseName} and backend_type = 'client backend'
          `);
          return rows.map((row) => row.pid).filter((pid) => !fixturePids.has(pid));
        },
        { timeout: 2_000, interval: 50 },
      )
      .toEqual([]);
  }, 30_000);

  it('applies lock, statement and idle-in-transaction timeouts to every statement', async () => {
    const folder = await migrationFolder('9000_timeout_probe', [
      `CREATE TABLE "timeout_probe" AS SELECT
        current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_timeout`,
      `INSERT INTO "timeout_probe" SELECT
        current_setting('lock_timeout'),
        current_setting('statement_timeout'),
        current_setting('idle_in_transaction_session_timeout')`,
    ]);
    await runMigrationsWithLock(live!.connectionString, { migrationsFolder: folder });
    const rows = await live!.db.execute(
      sql`select lock_timeout, statement_timeout, idle_timeout from timeout_probe`,
    );
    // Defaults: 3s to obtain any lock, 15 minutes per statement, 10 seconds idle.
    expect(Array.from(rows)).toEqual([
      { lock_timeout: '3s', statement_timeout: '15min', idle_timeout: '10s' },
      { lock_timeout: '3s', statement_timeout: '15min', idle_timeout: '10s' },
    ]);
    // The settings are transaction-local: nothing leaks into the session or database.
    const [defaults] = await live!.db.execute<{ lock_timeout: string }>(
      sql`select current_setting('lock_timeout') as lock_timeout`,
    );
    expect(defaults!.lock_timeout).toBe('0');
  });

  it('honours configured timeouts and fails at once, without retrying, on a statement timeout', async () => {
    const folder = await migrationFolder('9000_slow_statement', [
      'CREATE TABLE "slow_probe" (id integer)',
      'SELECT pg_sleep(5)',
    ]);
    const retries: unknown[] = [];
    const started = Date.now();
    const result = await settle(
      runMigrationsWithLock(live!.connectionString, {
        migrationsFolder: folder,
        lockTimeoutMs: 1_234,
        statementTimeoutMs: 300,
        onRetry: (event) => retries.push(event),
      }),
    );
    expect(result.status).toBe('rejected');
    expect(rootCause((result as { error: unknown }).error)).toMatchObject({ code: '57014' });
    expect(retries).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
    const [table] = await live!.db.execute<{ name: string | null }>(
      sql`select to_regclass('public.slow_probe')::text as name`,
    );
    expect(table!.name).toBeNull();
    expect(await journalRecorded()).toBe(false);
  }, 15_000);
});
