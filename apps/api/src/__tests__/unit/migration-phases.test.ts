import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backgroundMigrations,
  describeRequirement,
  indexBuild,
  loadSqlParser,
  mustRunOutsideTransaction,
  parseStatements,
  pendingMigrations,
  postMigrationTimeoutsFromEnv,
  readPostSteps,
  readReleaseManifest,
  releaseOf,
  rewriteMessagesInPlace,
  secretReencryptionMigrations,
  statementCost,
  tablesCreated,
  tablesTouched,
  UnfinishedRequirementsError,
  usageRollupBackfill,
} from '@oci/db';
import type { UpgradeReport } from '@oci/shared';
import { updateBackgroundMigrationSchema } from '@oci/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../config/env.js';

vi.mock('../../db/index.js', () => ({ sql: null, db: null }));

const { progressOf } = await import('../../services/migrations/background-admin.js');
const { formatBytes, verdictOf } = await import('../../services/migrations/preflight.js');
const { renderReport } = await import('../../services/migrations/report-text.js');
const { duration } = await import('../../services/migrations/throttle.js');
const { autoPostMigrations } = await import('../../services/migrations/jobs.js');

beforeAll(loadSqlParser);

const one = (text: string) => parseStatements(text)[0]!;

describe('sql analysis', () => {
  it('names the tables a statement touches, qualified, without CTE names', () => {
    expect(
      tablesTouched(
        one(`with recent as (select id from "message" where created_at > now())
             update thread t set title = 'x' from recent where t.id = recent.id`),
      ),
    ).toEqual(['public.thread', 'public.message']);
    expect(
      tablesTouched(
        one(
          'ALTER TABLE "usage_event" ADD CONSTRAINT f FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") NOT VALID',
        ),
      ),
    ).toEqual(['public.usage_event', 'public.user']);
    expect(tablesTouched(one('DROP TABLE IF EXISTS "old", audit.archive'))).toEqual([
      'public.old',
      'audit.archive',
    ]);
    expect(
      tablesTouched(
        one(
          `DO $$ BEGIN ALTER TABLE "a" ADD COLUMN "b" text; EXCEPTION WHEN others THEN NULL; END $$`,
        ),
      ),
    ).toEqual(['public.a']);
  });

  it('classifies cost by what the statement does to existing rows', () => {
    const cost = (text: string) => statementCost(one(text));
    expect(cost('CREATE TABLE t (id text)')).toBe('catalog');
    expect(cost('ALTER TABLE t ADD COLUMN c text')).toBe('catalog');
    expect(cost("ALTER TABLE t ADD COLUMN c text DEFAULT 'x'")).toBe('catalog');
    expect(cost('ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid()')).toBe('rewrite');
    expect(cost('ALTER TABLE t ADD COLUMN c bigserial')).toBe('rewrite');
    expect(cost('ALTER TABLE t ADD COLUMN c integer GENERATED ALWAYS AS (1) STORED')).toBe(
      'rewrite',
    );
    expect(cost('ALTER TABLE t ADD COLUMN c text REFERENCES u(id)')).toBe('scan');
    expect(cost('ALTER TABLE t ADD COLUMN c text UNIQUE')).toBe('index');
    expect(cost('ALTER TABLE t ALTER COLUMN c TYPE bigint')).toBe('rewrite');
    expect(cost('ALTER TABLE t ALTER COLUMN c SET NOT NULL')).toBe('scan');
    expect(cost('ALTER TABLE t VALIDATE CONSTRAINT k')).toBe('scan');
    expect(cost('ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0) NOT VALID')).toBe('catalog');
    expect(cost('ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0)')).toBe('scan');
    expect(cost('ALTER TABLE t ADD CONSTRAINT k UNIQUE (c)')).toBe('index');
    expect(cost('ALTER TABLE t ADD CONSTRAINT k UNIQUE USING INDEX t_c_idx')).toBe('catalog');
    expect(cost('CREATE INDEX i ON t (c)')).toBe('index');
    expect(cost('CREATE INDEX CONCURRENTLY i ON t (c)')).toBe('concurrent-index');
    expect(cost('REINDEX INDEX CONCURRENTLY i')).toBe('concurrent-index');
    expect(cost('REINDEX TABLE t')).toBe('index');
    expect(cost('UPDATE t SET c = 1')).toBe('data');
    expect(cost('DELETE FROM t')).toBe('data');
    expect(cost('TRUNCATE t')).toBe('data');
    expect(cost("INSERT INTO t VALUES ('a')")).toBe('catalog');
    expect(cost('INSERT INTO t SELECT * FROM u')).toBe('data');
    expect(cost('LOCK TABLE t')).toBe('lock');
    expect(cost('VACUUM FULL t')).toBe('rewrite');
    expect(cost('VACUUM t')).toBe('catalog');
    expect(cost('CLUSTER t USING i')).toBe('rewrite');
    expect(cost('REFRESH MATERIALIZED VIEW v')).toBe('scan');
    expect(cost('REFRESH MATERIALIZED VIEW CONCURRENTLY v')).toBe('catalog');
    expect(cost('DO $$ BEGIN UPDATE t SET c = 1; END $$')).toBe('data');
    expect(cost('DO $$ BEGIN PERFORM 1; END $$')).toBe('catalog');
    expect(cost('SELECT 1')).toBe('catalog');
  });

  it('reads the index a statement builds, with its predicate', () => {
    expect(
      indexBuild(
        one(
          `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "m_idx" ON "s"."message" USING btree ("created_at", "id") WHERE "status" = 'error' AND "note" <> 'where';`,
        ),
      ),
    ).toEqual({
      schema: 's',
      name: 'm_idx',
      table: 's.message',
      concurrent: true,
      ifNotExists: true,
      unique: true,
      method: 'btree',
      columns: ['created_at', 'id'],
      expression: false,
      predicate: `"status" = 'error' AND "note" <> 'where'`,
    });
    expect(
      indexBuild(one("CREATE INDEX ON t USING gin (to_tsvector('simple', body))")),
    ).toMatchObject({
      name: null,
      method: 'gin',
      columns: [],
      expression: true,
      predicate: null,
    });
    expect(indexBuild(one('SELECT 1'))).toBeNull();
  });

  it('knows what cannot run in a transaction, and what a statement creates', () => {
    expect(mustRunOutsideTransaction(one('CREATE INDEX CONCURRENTLY i ON t (c)'))).toBe(true);
    expect(mustRunOutsideTransaction(one('DROP INDEX CONCURRENTLY i'))).toBe(true);
    expect(mustRunOutsideTransaction(one('VACUUM t'))).toBe(true);
    expect(mustRunOutsideTransaction(one('CREATE INDEX i ON t (c)'))).toBe(false);
    expect(tablesCreated(one('CREATE TABLE "n" (id text)'))).toEqual(['public.n']);
    expect(tablesCreated(one('CREATE TABLE x.n AS SELECT 1'))).toEqual(['x.n']);
    expect(tablesCreated(one('DO $$ BEGIN CREATE TABLE "d" (id text); END $$'))).toEqual([
      'public.d',
    ]);
    expect(tablesCreated(one('SELECT 1'))).toEqual([]);
  });

  it('splits on breakpoints, keeps statement text, and rejects what PostgreSQL would', () => {
    const statements = parseStatements(
      '-- a comment\nCREATE TABLE a (id text);\n--> statement-breakpoint\n/* block */ SELECT 1; SELECT 2;',
    );
    expect(statements.map((statement) => [statement.type, statement.text])).toEqual([
      ['CreateStmt', 'CREATE TABLE a (id text)'],
      ['SelectStmt', 'SELECT 1'],
      ['SelectStmt', 'SELECT 2'],
    ]);
    expect(() => parseStatements('CREATE TABLE (')).toThrow();
  });
});

describe('release manifest and journals', () => {
  const journal = [
    { idx: 0, tag: '0000_a', when: 10 },
    { idx: 1, tag: '0001_b', when: 20 },
    { idx: 2, tag: '0002_c', when: 30 },
  ];
  const manifest = [
    { version: '1.0.0', firstMigration: '0000_a' },
    { version: '1.1.0', firstMigration: '0002_c', requires: { postSteps: ['p'] } },
    { version: '9.9.9', firstMigration: 'elsewhere' },
  ];

  it('maps migrations to the release they start or continue', () => {
    expect(releaseOf('0000_a', journal, manifest)?.version).toBe('1.0.0');
    expect(releaseOf('0001_b', journal, manifest)?.version).toBe('1.0.0');
    expect(releaseOf('0002_c', journal, manifest)?.version).toBe('1.1.0');
    expect(releaseOf('missing', journal, manifest)).toBeNull();
    expect(releaseOf('0000_a', journal, [])).toBeNull();
  });

  it('treats migrations newer than the latest recorded as pending, as Drizzle does', () => {
    expect(
      pendingMigrations(journal, { migrated: true, applied: [10, 20] }).map((e) => e.tag),
    ).toEqual(['0002_c']);
    expect(pendingMigrations(journal, { migrated: false, applied: [] })).toHaveLength(3);
    expect(pendingMigrations(journal, { migrated: true, applied: [10, 20, 30, 40] })).toEqual([]);
  });

  it('the bundled manifest starts each release at a real migration', async () => {
    const releases = readReleaseManifest();
    expect(releases.at(-1)).toMatchObject({
      version: '0.11.0',
      firstMigration: '0039_three_phase_migrations',
    });
    const bundled = (await import('@oci/db')).readJournal();
    for (const release of releases) {
      expect(
        bundled.some((entry) => entry.tag === release.firstMigration),
        release.version,
      ).toBe(true);
    }
  });

  it('describes unfinished requirements', () => {
    const error = new UnfinishedRequirementsError([
      { kind: 'post-step', name: '0003_x', requiredBy: '0.12.0', state: 'not applied' },
      { kind: 'background-migration', name: '0.11.y', requiredBy: '0.12.0', state: 'paused' },
    ]);
    expect(error.message).toMatch(
      /^Release 0\.12\.0 needs earlier work finished before its database migrations can run: post-deploy step "0003_x" \(not applied\); background migration "0\.11\.y" \(paused\)\./,
    );
    expect(describeRequirement(error.unfinished[1]!)).toBe(
      'background migration "0.11.y" (paused)',
    );
  });
});

describe('post-deploy folder', () => {
  let folder: string;
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'oci-post-unit-'));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const write = (journal: unknown, files: Record<string, string>) => {
    rmSync(folder, { recursive: true, force: true });
    folder = mkdtempSync(join(tmpdir(), 'oci-post-unit-'));
    writeFileSync(join(folder, 'journal.json'), JSON.stringify(journal));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
    return folder;
  };

  it('reads the bundled steps: one concurrent index build each', () => {
    const steps = readPostSteps();
    expect(steps.map((step) => [step.name, step.release, step.index?.name])).toEqual([
      ['0001_message_created_at_index', '0.11.0', 'message_created_at_idx'],
      ['0002_message_error_created_at_index', '0.11.0', 'message_error_created_at_idx'],
      ['0003_message_sent_created_at_index', '0.11.0', 'message_sent_created_at_idx'],
      ['0004_message_web_search_created_at_index', '0.11.0', 'message_web_search_created_at_idx'],
      ['0005_message_cancelled_created_at_index', '0.11.0', 'message_cancelled_created_at_idx'],
      ['0006_thread_created_at_index', '0.11.0', 'thread_created_at_idx'],
    ]);
    expect(steps.every((step) => step.index?.concurrent && step.index.ifNotExists)).toBe(true);
    expect(steps[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has no steps without a journal, and refuses a journal that disagrees with the files', () => {
    expect(readPostSteps(join(folder, 'nowhere'))).toEqual([]);
    expect(() =>
      readPostSteps(
        write({ steps: [{ idx: 1, tag: '0001_a', release: '1' }] }, { '0001_a.sql': 'SELECT 1;' }),
      ),
    ).toThrow(/idx 1, not 0/);
    expect(() =>
      readPostSteps(write({ steps: [{ idx: 0, tag: '0001_a', release: '1' }] }, {})),
    ).toThrow(/0001_a has no file/);
  });
});

describe('background migrations', () => {
  it('registers test definitions only when the environment names them', () => {
    const release = [usageRollupBackfill, ...secretReencryptionMigrations];
    expect(backgroundMigrations({})).toEqual(release);
    expect(
      backgroundMigrations({
        OCI_TEST_BACKGROUND_MIGRATIONS: ` other, ${rewriteMessagesInPlace.name} `,
      }),
    ).toEqual([...release, rewriteMessagesInPlace]);
  });

  it('estimates progress from a UUID cursor, or rows against the estimate', () => {
    expect(
      progressOf({ status: 'finished', cursor: null, rowsProcessed: 0, estimatedRows: null }),
    ).toBe(1);
    expect(
      progressOf({ status: 'pending', cursor: null, rowsProcessed: 0, estimatedRows: 10 }),
    ).toBe(0);
    expect(
      progressOf({
        status: 'running',
        cursor: '80000000-0000-4000-8000-000000000000',
        rowsProcessed: 3,
        estimatedRows: 1_000,
      }),
    ).toBe(0.5);
    expect(
      progressOf({
        status: 'running',
        cursor: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        rowsProcessed: 3,
        estimatedRows: null,
      }),
    ).toBe(0.999);
    expect(
      progressOf({ status: 'running', cursor: '42', rowsProcessed: 250, estimatedRows: 1_000 }),
    ).toBe(0.25);
    expect(
      progressOf({ status: 'running', cursor: '42', rowsProcessed: 5_000, estimatedRows: 1_000 }),
    ).toBe(0.99);
    expect(
      progressOf({ status: 'running', cursor: '42', rowsProcessed: 5, estimatedRows: null }),
    ).toBeNull();
  });

  it('formats durations and sizes for people', () => {
    expect(duration(850)).toBe('850 ms');
    expect(duration(12_400)).toBe('12 s');
    expect(duration(7 * 60_000)).toBe('7 min');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_536)).toBe('1.5 KB');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11 MB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('validates administrator changes', () => {
    expect(updateBackgroundMigrationSchema.safeParse({ batchSize: 500 }).success).toBe(true);
    expect(updateBackgroundMigrationSchema.safeParse({ pauseMs: 0 }).success).toBe(true);
    expect(updateBackgroundMigrationSchema.safeParse({}).success).toBe(false);
    expect(updateBackgroundMigrationSchema.safeParse({ batchSize: 100_001 }).success).toBe(false);
    expect(updateBackgroundMigrationSchema.safeParse({ pauseMs: -1 }).success).toBe(false);
    expect(updateBackgroundMigrationSchema.safeParse({ batchSize: 5, cursor: 'x' }).success).toBe(
      false,
    );
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://x@localhost/x',
    AUTH_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: 'b'.repeat(32),
  };

  it('applies post-deploy steps automatically only where RUN_MIGRATIONS (or the override) says so', () => {
    expect(autoPostMigrations(parseEnv(base))).toBe(true);
    expect(autoPostMigrations(parseEnv({ ...base, RUN_MIGRATIONS: 'false' }))).toBe(false);
    expect(
      autoPostMigrations(
        parseEnv({ ...base, RUN_MIGRATIONS: 'false', RUN_POST_MIGRATIONS: 'true' }),
      ),
    ).toBe(true);
    expect(autoPostMigrations(parseEnv({ ...base, RUN_POST_MIGRATIONS: 'false' }))).toBe(false);
  });

  it('validates the background migration and post-deploy settings', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      BACKGROUND_MIGRATIONS_ENABLED: true,
      BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS: 10_000,
      BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS: 300_000,
      BACKGROUND_MIGRATION_BATCH_TIMEOUT_MS: 30_000,
      POST_MIGRATION_STATEMENT_TIMEOUT_MS: 14_400_000,
    });
    expect(() => parseEnv({ ...base, BACKGROUND_MIGRATION_BATCH_TIMEOUT_MS: '5' })).toThrow();
    expect(postMigrationTimeoutsFromEnv({})).toMatchObject({
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 14_400_000,
    });
    expect(
      postMigrationTimeoutsFromEnv({
        POST_MIGRATION_STATEMENT_TIMEOUT_MS: '0',
        MIGRATION_LOCK_TIMEOUT_MS: '500',
      }),
    ).toMatchObject({ lockTimeoutMs: 500, statementTimeoutMs: 0 });
    expect(() =>
      postMigrationTimeoutsFromEnv({ POST_MIGRATION_STATEMENT_TIMEOUT_MS: 'soon' }),
    ).toThrow(/POST_MIGRATION_STATEMENT_TIMEOUT_MS/);
  });
});

describe('upgrade verdict and its text', () => {
  const base: Omit<UpgradeReport, 'verdict'> = {
    generatedAt: '2026-10-04T00:00:00.000Z',
    bundled: {
      version: '0.11.0',
      latestMigration: '0039_x',
      migrations: 40,
      postSteps: 1,
      backgroundMigrations: 0,
    },
    database: {
      fresh: false,
      latestMigration: '0039_x',
      release: '0.11.0',
      applied: 40,
      unknownNewer: 0,
    },
    preDeploy: [],
    postDeploy: [],
    background: [],
    requirements: [],
    indexes: { toBuild: 0, estimatedBytes: 0, invalid: [] },
  };
  const background = {
    name: '0.11.b',
    description: null,
    release: '0.11.0',
    table: 'public.message',
    bundled: true,
    cursor: null,
    batchSize: 1,
    pauseMs: 0,
    rowsProcessed: 10,
    batches: 1,
    estimatedRows: 100,
    tableBytes: 1,
    progress: 0.1,
    attempts: 0,
    lastError: 'boom',
    leaseOwner: null,
    leaseUntil: null,
    nextRunAt: null,
    throttledReason: 'Replication lag 30 s is over 10 s',
    throttledAt: null,
    startedAt: null,
    finishedAt: null,
  } as const;

  it('is current with nothing to do, and reports work still in progress', () => {
    expect(verdictOf(base).mode).toBe('current');
    const running = verdictOf({ ...base, background: [{ ...background, status: 'running' }] });
    expect(running.mode).toBe('current');
    expect(running.reasons).toEqual(['1 background migration(s) in progress (0.11.b: running).']);
    const text = renderReport({
      ...base,
      background: [{ ...background, status: 'running' }],
      verdict: running,
    });
    expect(text).toMatch(/0\.11\.b on public\.message: running 10% \(10 of ~100 rows\)/);
    expect(text).toMatch(/last error: boom/);
    expect(text).toMatch(/waiting: Replication lag 30 s/);
  });

  it('renders steps in every state', () => {
    const statement = {
      summary: 'CREATE INDEX CONCURRENTLY i ON t (c)',
      cost: 'concurrent-index' as const,
      tables: [{ name: 'public.t', exists: true, rows: null, bytes: 2048 }],
      fast: true,
      reason: null,
    };
    const step = {
      name: '0001_i',
      release: '0.11.0',
      attempts: 2,
      lastError: 'canceling statement due to lock timeout',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      statement,
      index: {
        name: 'i',
        table: 'public.t',
        estimatedBytes: null,
        sizedFromStatistics: false,
        invalidExists: true,
        exists: false,
      },
    };
    const report = {
      ...base,
      database: { ...base.database, unknownNewer: 2, latestMigration: null, release: null },
      postDeploy: [
        { ...step, state: 'started' as const },
        { ...step, name: '0002_j', state: 'finished' as const, durationMs: 12 },
        {
          ...step,
          name: '0003_k',
          state: 'pending' as const,
          index: { ...step.index, estimatedBytes: 4096, invalidExists: false },
        },
      ],
      background: [
        { ...background, status: 'not_scheduled' as const, bundled: false, progress: null },
      ],
      indexes: { toBuild: 1, estimatedBytes: 4096, invalid: ['public.i'] },
    };
    const text = renderReport({ ...report, verdict: verdictOf(report) });
    expect(text).toMatch(
      /before 0\.7 \(a migration this release does not include; 40 applied, 2 newer than this release\)/,
    );
    expect(text).toMatch(
      /0001_i \(0\.11\.0\): started, not finished \(2 attempt\(s\): canceling statement/,
    );
    expect(text).toMatch(
      /index i: size unknown; an INVALID copy from an interrupted build will be dropped and rebuilt/,
    );
    expect(text).toMatch(/0002_j \(0\.11\.0\): finished in 12 ms/);
    expect(text).toMatch(/index i: about 4\.0 KB \(rough\)/);
    expect(text).toMatch(/not scheduled .*\[not in this release\]/);
    expect(text).toMatch(/keep at least 8\.0 KB free/);
    expect(text).toMatch(/INVALID indexes: public\.i/);
    expect(text).toMatch(/Verdict: BLOCKED/);
  });
});
