import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BackgroundMigrationDefinition,
  postStepStates,
  readJournal,
  runPostMigrations,
  sql,
} from '@oci/db';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * Post-deploy steps (v0.11 design, section 1): `migrate --post` runs each
 * step outside a transaction, records it in `oci_post_migration`, and repeats
 * what did not finish. The case PostgreSQL leaves to the caller is an
 * interrupted `CREATE INDEX CONCURRENTLY`: it leaves an INVALID index, and
 * repeating the statement with IF NOT EXISTS then succeeds without building
 * anything. Reproduced first below; the runner drops and rebuilds it.
 */

const available = await livePostgresAvailable();
const quiet = { info: () => {}, warn: () => {} };

describe.skipIf(!available)('live PostgreSQL post-deploy steps', () => {
  let live: LiveDatabase;
  let folders: string[] = [];
  let clients: postgres.Sql[] = [];

  beforeEach(async () => {
    live = await createLiveDatabase('post_migrations');
    await live.db.execute(sql`create table post_probe (id integer primary key, a text)`);
    await live.db.execute(
      sql`insert into post_probe select g, md5(g::text) from generate_series(1, 2000) g`,
    );
  });

  afterEach(async () => {
    for (const client of clients) await client.end({ timeout: 1 }).catch(() => {});
    clients = [];
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
    folders = [];
    await live?.destroy();
  });

  function client(): postgres.Sql {
    const created = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    clients.push(created);
    return created;
  }

  async function postFolder(steps: Record<string, string>): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'oci-post-'));
    folders.push(folder);
    const journal = {
      steps: Object.keys(steps).map((tag, idx) => ({ idx, tag, release: '9.9.0' })),
    };
    await writeFile(join(folder, 'journal.json'), JSON.stringify(journal));
    for (const [tag, text] of Object.entries(steps))
      await writeFile(join(folder, `${tag}.sql`), text);
    return folder;
  }

  /** An open transaction that wrote to post_probe: a concurrent build waits for it. */
  async function holdWriter() {
    const reserved = await client().reserve();
    await reserved`begin`;
    await reserved`update post_probe set a = a where id = 1`;
    return {
      release: async () => {
        await reserved`commit`;
        reserved.release();
      },
    };
  }

  async function indexState(name: string): Promise<'missing' | 'valid' | 'invalid'> {
    const [row] = await live.db.execute<{ valid: boolean }>(sql`
      select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid
      where c.relname = ${name}`);
    return row ? (row.valid ? 'valid' : 'invalid') : 'missing';
  }

  async function recorded(name: string) {
    const [row] = await live.db.execute<{
      finished: boolean;
      attempts: number;
      last_error: string | null;
    }>(sql`select finished_at is not null as finished, attempts, last_error
      from oci_post_migration where name = ${name}`);
    return row;
  }

  const INDEX = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "post_probe_a_idx" ON "post_probe" ("a");';

  it('reproduction: an interrupted concurrent build leaves an INVALID index that IF NOT EXISTS accepts', async () => {
    const writer = await holdWriter();
    const builder = client();
    await builder`set lock_timeout = '300ms'`;
    await expect(builder.unsafe(INDEX).simple()).rejects.toMatchObject({ code: '55P03' });
    await writer.release();
    expect(await indexState('post_probe_a_idx')).toBe('invalid');
    // Running the same idempotent statement again "succeeds" and builds nothing.
    await builder.unsafe(INDEX).simple();
    expect(await indexState('post_probe_a_idx')).toBe('invalid');
  });

  it('drops an INVALID index left by an interrupted build and builds it again', async () => {
    const folder = await postFolder({ '0001_probe_index': INDEX });
    // A build cut off by a lock timeout, as a failover or a killed job would leave it.
    const writer = await holdWriter();
    const builder = client();
    await builder`set lock_timeout = '300ms'`;
    await builder
      .unsafe(INDEX)
      .simple()
      .catch(() => {});
    await writer.release();
    expect(await indexState('post_probe_a_idx')).toBe('invalid');

    const result = await runPostMigrations(live.connectionString, { folder, logger: quiet });
    expect(result.steps).toEqual([
      expect.objectContaining({
        name: '0001_probe_index',
        outcome: 'applied',
        rebuiltInvalidIndex: true,
      }),
    ]);
    expect(await indexState('post_probe_a_idx')).toBe('valid');
    expect(await recorded('0001_probe_index')).toMatchObject({ finished: true, last_error: null });

    // Finished steps are skipped from then on.
    const again = await runPostMigrations(live.connectionString, { folder, logger: quiet });
    expect(again.steps[0]).toMatchObject({ outcome: 'skipped', attempts: 0 });
  });

  it('repeats a step whose session was terminated mid-build', { timeout: 15_000 }, async () => {
    const folder = await postFolder({ '0001_probe_index': INDEX });
    const writer = await holdWriter();
    // The runner's statement waits for the writer; end its backend, as a failover does.
    const run = runPostMigrations(live.connectionString, {
      folder,
      logger: quiet,
      lockTimeoutMs: 60_000,
    });
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) {
      await sleep(50);
      const [row] = await live.db.execute<{ pid: number }>(sql`
        select pid from pg_stat_activity
        where application_name = 'oci-migrate-post' and query ilike 'CREATE INDEX%'`);
      pid = row?.pid;
    }
    expect(pid).toBeDefined();
    await live.db.execute(sql`select pg_terminate_backend(${pid!})`);
    await expect(run).rejects.toThrow(
      /0001_probe_index was interrupted: the database connection was lost/,
    );
    await writer.release();
    expect(await indexState('post_probe_a_idx')).toBe('invalid');
    expect(await recorded('0001_probe_index')).toMatchObject({ finished: false });
    const [state] = await postStepStates(client(), folder);
    expect(state).toMatchObject({ state: 'started' });

    const result = await runPostMigrations(live.connectionString, { folder, logger: quiet });
    expect(result.steps[0]).toMatchObject({ outcome: 'applied', rebuiltInvalidIndex: true });
    expect(await indexState('post_probe_a_idx')).toBe('valid');
  });

  it('retries lock timeouts with backoff, then fails clearly and records the step unfinished', async () => {
    const folder = await postFolder({
      '0001_probe_index': INDEX,
      '0002_probe_analyze': 'ANALYZE "post_probe";',
    });
    const writer = await holdWriter();
    const failed = runPostMigrations(live.connectionString, {
      folder,
      logger: quiet,
      lockTimeoutMs: 200,
      maxAttempts: 2,
      retryDelayMs: 50,
    });
    await expect(failed).rejects.toThrow(
      /Post-deploy step 0001_probe_index failed: waited more than 200ms for a lock on each of 2 attempts/,
    );
    expect(await recorded('0001_probe_index')).toMatchObject({ finished: false, attempts: 2 });
    expect((await recorded('0001_probe_index'))?.last_error).toMatch(/lock timeout/);
    // A later step never runs before an earlier one finished.
    expect(await recorded('0002_probe_analyze')).toBeUndefined();

    // Freed part-way through the retries: the next attempt succeeds.
    const run = runPostMigrations(live.connectionString, {
      folder,
      logger: quiet,
      lockTimeoutMs: 200,
      maxAttempts: 10,
      retryDelayMs: 100,
    });
    await sleep(500);
    await writer.release();
    const result = await run;
    expect(result.steps.map((step) => step.outcome)).toEqual(['applied', 'applied']);
    expect(result.steps[0]!.attempts).toBeGreaterThan(1);
    expect(await indexState('post_probe_a_idx')).toBe('valid');
  });

  it('fails a broken step at once and keeps its error', async () => {
    const folder = await postFolder({
      '0001_broken': 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "nope_idx" ON "missing_table" ("a");',
    });
    await expect(
      runPostMigrations(live.connectionString, { folder, logger: quiet }),
    ).rejects.toThrow(/0001_broken failed: relation "missing_table" does not exist/);
    expect(await recorded('0001_broken')).toMatchObject({ finished: false, attempts: 1 });
  });

  it('refuses to run before every pre-deploy migration of the release is applied', async () => {
    const folder = await postFolder({ '0001_probe_index': INDEX });
    const migrations = await mkdtemp(join(tmpdir(), 'oci-post-pre-'));
    folders.push(migrations);
    await mkdir(join(migrations, 'meta'));
    const latest = readJournal().at(-1)!;
    await writeFile(
      join(migrations, 'meta', '_journal.json'),
      JSON.stringify({
        entries: [
          { ...latest, idx: 0 },
          {
            idx: 1,
            version: '7',
            when: 4_000_000_000_000,
            tag: '9999_unapplied',
            breakpoints: true,
          },
        ],
      }),
    );
    await expect(
      runPostMigrations(live.connectionString, {
        folder,
        migrationsFolder: migrations,
        logger: quiet,
      }),
    ).rejects.toThrow(/only after every pre-deploy migration of this release is applied/);
    expect(await indexState('post_probe_a_idx')).toBe('missing');
  });

  it('refuses a step that is not exactly one statement, or not in the journal', async () => {
    const two = await postFolder({ '0001_two': 'ANALYZE "post_probe";\nANALYZE "post_probe";' });
    await expect(
      runPostMigrations(live.connectionString, { folder: two, logger: quiet }),
    ).rejects.toThrow(/has 2 statements; a step is exactly one/);
    const stray = await postFolder({ '0001_ok': 'ANALYZE "post_probe";' });
    await writeFile(join(stray, '0002_stray.sql'), 'ANALYZE "post_probe";');
    await expect(
      runPostMigrations(live.connectionString, { folder: stray, logger: quiet }),
    ).rejects.toThrow(/0002_stray.sql is not in journal.json/);
  });

  it('serialises concurrent runs and schedules background migrations once', async () => {
    const folder = await postFolder({ '0001_probe_index': INDEX });
    const definition: BackgroundMigrationDefinition = {
      name: 'test.noop',
      release: 'test',
      table: 'public.post_probe',
      description: 'Does nothing.',
      batchSize: 10,
      pauseMs: 0,
      batch: async () => ({ cursor: null, rows: 0, done: true }),
    };
    const options = { folder, logger: quiet, backgroundMigrations: [definition] };
    const [a, b] = await Promise.all([
      runPostMigrations(live.connectionString, options),
      runPostMigrations(live.connectionString, options),
    ]);
    expect([a.steps[0]!.outcome, b.steps[0]!.outcome].sort()).toEqual(['applied', 'skipped']);
    expect([...a.scheduled, ...b.scheduled]).toEqual(['test.noop']);
    const [row] = await live.db.execute<{
      status: string;
      estimated_rows: string;
      batch_size: number;
    }>(
      sql`select status, estimated_rows::text, batch_size from background_migration where name = 'test.noop'`,
    );
    expect(row).toMatchObject({ status: 'pending', batch_size: 10 });
  });

  it('applies the bundled steps: the message, thread and audit log indexes', async () => {
    const result = await runPostMigrations(live.connectionString, { logger: quiet });
    expect(result.steps.map((step) => [step.name, step.outcome])).toEqual([
      ['0001_message_created_at_index', 'applied'],
      ['0002_message_error_created_at_index', 'applied'],
      ['0003_message_sent_created_at_index', 'applied'],
      ['0004_message_web_search_created_at_index', 'applied'],
      ['0005_message_cancelled_created_at_index', 'applied'],
      ['0006_thread_created_at_index', 'applied'],
      ['0007_audit_log_target_index', 'applied'],
      ['0008_audit_log_user_ids_index', 'applied'],
    ]);
    for (const name of [
      'message_created_at_idx',
      'message_error_created_at_idx',
      'message_sent_created_at_idx',
      'message_web_search_created_at_idx',
      'message_cancelled_created_at_idx',
      'thread_created_at_idx',
      'audit_log_target_idx',
      'audit_log_user_ids_idx',
    ]) {
      expect(await indexState(name)).toBe('valid');
    }
  });
});
