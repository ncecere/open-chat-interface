import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BackgroundMigrationDefinition,
  createDatabase,
  DEFAULT_MIGRATIONS_FOLDER,
  eq,
  runPostMigrations,
  scheduleBackgroundMigrations,
  schema,
  sql,
} from '@oci/db';
import type { BackgroundMigrationSummary, UpgradeReport } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * System health, Upgrades and Background work (v0.11 design, sections 1 and
 * 6): the upgrade preflight and the background-migration controls, against
 * real PostgreSQL, as an administrator and as an auditor.
 */
const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const available = await livePostgresAvailable();
const { migrationRoutes } = await import('../../routes/admin/migrations.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { upgradeReport } = await import('../../services/migrations/preflight.js');
const { renderReport } = await import('../../services/migrations/report-text.js');

const quiet = { info: () => {}, warn: () => {} };

const probe: BackgroundMigrationDefinition = {
  name: 'test.admin-probe',
  release: 'test',
  table: 'public.message',
  description: 'Probe.',
  batchSize: 100,
  pauseMs: 10,
  batch: async () => ({ cursor: null, rows: 0, done: true }),
};

function appFor(actorId: string, role: 'admin' | 'auditor') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Migrations tester',
      email: `${role}-migrations@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/migrations', migrationRoutes);
  return app;
}

describe.skipIf(!available)('live: migrations administration and the upgrade preflight', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: Hono<AppBindings>;
  let auditor: Hono<AppBindings>;
  const folders: string[] = [];

  const request = (app: Hono<AppBindings>, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  /** The bundled migrations plus extra pending ones, in a temporary folder. */
  function folderWith(extra: Record<string, string>): string {
    const folder = mkdtempSync(join(tmpdir(), 'oci-preflight-'));
    folders.push(folder);
    cpSync(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    for (const [tag, text] of Object.entries(extra)) {
      const last = journal.entries.at(-1);
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
      writeFileSync(join(folder, `${tag}.sql`), text);
    }
    writeFileSync(journalPath, JSON.stringify(journal));
    return folder;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_migrations');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    admin = appFor(await seedUser(pool.db, state.organizationId, { role: 'admin' }), 'admin');
    auditor = appFor(await seedUser(pool.db, state.organizationId, { role: 'auditor' }), 'auditor');
    await pool.sql`create table big_probe (id integer primary key, a text)`;
    await pool.sql`insert into big_probe select g, md5(g::text) from generate_series(1, 20000) g`;
    await pool.sql`analyze big_probe`;
  });
  afterAll(async () => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('reports a deployed release with its post-deploy steps waiting, readable by auditors', async () => {
    const response = await request(auditor, 'GET', '/migrations/upgrade');
    expect(response.status).toBe(200);
    const report = (await response.json()) as UpgradeReport;
    expect(report.database).toMatchObject({ fresh: false, unknownNewer: 0, release: '0.11.0' });
    expect(report.preDeploy).toEqual([]);
    expect(report.postDeploy.map((step) => [step.name, step.state])).toEqual([
      ['0001_message_created_at_index', 'pending'],
      ['0002_message_error_created_at_index', 'pending'],
      ['0003_message_sent_created_at_index', 'pending'],
      ['0004_message_web_search_created_at_index', 'pending'],
      ['0005_message_cancelled_created_at_index', 'pending'],
      ['0006_thread_created_at_index', 'pending'],
      ['0007_audit_log_target_index', 'pending'],
      ['0008_audit_log_user_ids_index', 'pending'],
      ['0009_artifact_kind_code', 'pending'],
      ['0010_audit_log_actor_email_index', 'pending'],
      ['0011_attachment_storage_key_index', 'pending'],
      ['0012_attachment_thumbnail_key_index', 'pending'],
      ['0013_message_text_search_folded_index', 'pending'],
    ]);
    const [created] = report.postDeploy;
    expect(created!.statement).toMatchObject({ cost: 'concurrent-index', fast: true });
    expect(created!.statement.tables).toEqual([
      expect.objectContaining({ name: 'public.message', exists: true }),
    ]);
    expect(created!.index).toMatchObject({
      name: 'message_created_at_idx',
      table: 'public.message',
      sizedFromStatistics: true,
      exists: false,
      invalidExists: false,
    });
    expect(created!.index!.estimatedBytes).toBeGreaterThan(0);
    expect(report.indexes.toBuild).toBe(12);
    expect(report.verdict.mode).toBe('rolling');
    expect(report.verdict.summary).toMatch(/Run `migrate --post`/);
    expect(renderReport(report)).toMatch(/Verdict: ROLLING/);
  });

  it('is current once `migrate --post` has run, and lists INVALID indexes', async () => {
    await runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] });
    const report = await upgradeReport(pool.sql, { definitions: [] });
    expect(report.verdict.mode).toBe('current');
    expect(report.postDeploy.every((step) => step.state === 'finished')).toBe(true);

    // An interrupted concurrent build, outside any post-deploy step.
    const reserved = await pool.sql.reserve();
    await reserved`begin`;
    await reserved`update big_probe set a = a where id = 1`;
    const builder = createDatabase(live.connectionString, { max: 1 }).sql;
    await builder`set lock_timeout = '200ms'`;
    await builder`create index concurrently if not exists stray_idx on big_probe (a)`.catch(
      () => {},
    );
    await reserved`commit`;
    reserved.release();
    await builder.end({ timeout: 1 });
    const withInvalid = await upgradeReport(pool.sql, { definitions: [] });
    expect(withInvalid.indexes.invalid).toEqual(['public.stray_idx']);
    expect(withInvalid.verdict.reasons.join(' ')).toMatch(/INVALID index\(es\).*public\.stray_idx/);
    await pool.sql`drop index stray_idx`;
  });

  it('needs a window when a pending pre-deploy statement grows with a large table', async () => {
    const folder = folderWith({
      '0040_slow': [
        'CREATE TABLE "fresh_probe" ("id" text PRIMARY KEY, "b" text);',
        'CREATE INDEX "fresh_probe_b_idx" ON "fresh_probe" ("b");',
        'ALTER TABLE "big_probe" ADD COLUMN "c" text;',
        'CREATE INDEX "big_probe_a_idx" ON "big_probe" ("a");',
      ].join('\n--> statement-breakpoint\n'),
    });
    const report = await upgradeReport(pool.sql, { migrationsFolder: folder, definitions: [] });
    expect(report.preDeploy).toHaveLength(1);
    const [migration] = report.preDeploy;
    expect(migration!.fast).toBe(false);
    expect(migration!.statements.map((statement) => [statement.cost, statement.fast])).toEqual([
      ['catalog', true],
      ['index', true],
      ['catalog', true],
      ['index', false],
    ]);
    expect(migration!.statements[3]!.reason).toMatch(
      /builds an index while blocking writes to public\.big_probe \(20,000 rows/,
    );
    expect(report.verdict.mode).toBe('window');
    expect(renderReport(report)).toMatch(/0040_slow \(0\.11\.0\): NOT FAST/);
  });

  it('is rolling when every pending statement is a catalog change', async () => {
    const folder = folderWith({
      '0040_fast': 'ALTER TABLE "big_probe" ADD COLUMN IF NOT EXISTS "d" text;',
    });
    const report = await upgradeReport(pool.sql, {
      migrationsFolder: folder,
      definitions: [probe],
    });
    expect(report.verdict.mode).toBe('rolling');
    expect(report.verdict.summary).toMatch(/run `migrate`, replace replicas one at a time/);
    expect(report.verdict.reasons.join(' ')).toMatch(/1 background migration\(s\) to be scheduled/);
  });

  it('needs a window when the schema is more than one minor behind', async () => {
    const folder = folderWith({
      '0040_fast': 'ALTER TABLE "big_probe" ADD COLUMN IF NOT EXISTS "d" text;',
    });
    const report = await upgradeReport(pool.sql, {
      migrationsFolder: folder,
      definitions: [],
      version: '0.13.0',
    });
    expect(report.verdict.mode).toBe('window');
    expect(report.verdict.reasons.join(' ')).toMatch(/more than one minor release behind 0\.13\.0/);
  });

  it('is blocked by unfinished required work, and by a newer database', async () => {
    const folder = folderWith({
      '0040_needs': 'ALTER TABLE "big_probe" ADD COLUMN IF NOT EXISTS "e" text;',
    });
    const report = await upgradeReport(pool.sql, {
      migrationsFolder: folder,
      definitions: [],
      manifest: [
        {
          version: '0.12.0',
          firstMigration: '0040_needs',
          requires: { backgroundMigrations: ['0.11.x'] },
        },
      ],
    });
    expect(report.requirements).toEqual([
      {
        kind: 'background-migration',
        name: '0.11.x',
        requiredBy: '0.12.0',
        state: 'not scheduled',
      },
    ]);
    expect(report.verdict.mode).toBe('blocked');
    expect(renderReport(report)).toMatch(
      /background-migration 0\.11\.x \(not scheduled\), required by 0\.12\.0/,
    );

    await pool.sql`insert into drizzle.__drizzle_migrations (hash, created_at)
      values ('newer', ${String(9_000_000_000_000)})`;
    const newer = await upgradeReport(pool.sql, { definitions: [] });
    expect(newer.database.unknownNewer).toBe(1);
    expect(newer.verdict.mode).toBe('blocked');
    expect(newer.verdict.reasons[0]).toMatch(/newer release migrated it/);
    await pool.sql`delete from drizzle.__drizzle_migrations where hash = 'newer'`;
  });

  it('lists background migrations and lets administrators, not auditors, change them', async () => {
    await scheduleBackgroundMigrations(pool.sql, [probe]);
    const listed = await request(auditor, 'GET', '/migrations/background');
    expect(listed.status).toBe(200);
    const { migrations } = (await listed.json()) as { migrations: BackgroundMigrationSummary[] };
    // Registered but not scheduled here (no `migrate --post` ran): listed too.
    expect(migrations.map((item) => [item.name, item.status])).toEqual([
      ['test.admin-probe', 'pending'],
      ['0.11.usage-rollups', 'not_scheduled'],
      // v0.11 key rotation: re-encryption of stored secrets, one per table.
      ['0.11.reencrypt-provider-keys', 'not_scheduled'],
      ['0.11.reencrypt-connector-credentials', 'not_scheduled'],
      ['0.11.reencrypt-connector-tokens', 'not_scheduled'],
      ['0.11.reencrypt-webhook-secrets', 'not_scheduled'],
      ['0.11.reencrypt-settings', 'not_scheduled'],
      // Forks and edits made before 0.11 get their own rows for shared files (#358).
      ['0.11.attachment-own-rows', 'not_scheduled'],
    ]);

    expect(
      (await request(auditor, 'POST', '/migrations/background/test.admin-probe/pause')).status,
    ).toBe(403);
    expect(
      (await request(auditor, 'PATCH', '/migrations/background/test.admin-probe', { batchSize: 5 }))
        .status,
    ).toBe(403);

    const paused = await request(admin, 'POST', '/migrations/background/test.admin-probe/pause');
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as BackgroundMigrationSummary).status).toBe('paused');
    const again = await request(admin, 'POST', '/migrations/background/test.admin-probe/pause');
    expect(again.status).toBe(409);
    const resumed = await request(admin, 'POST', '/migrations/background/test.admin-probe/resume');
    expect(((await resumed.json()) as BackgroundMigrationSummary).status).toBe('pending');

    const invalid = await request(admin, 'PATCH', '/migrations/background/test.admin-probe', {
      batchSize: 0,
    });
    expect(invalid.status).toBe(422);
    expect(
      (await request(admin, 'PATCH', '/migrations/background/test.admin-probe', {})).status,
    ).toBe(422);
    const changed = await request(admin, 'PATCH', '/migrations/background/test.admin-probe', {
      batchSize: 250,
      pauseMs: 1000,
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ batchSize: 250, pauseMs: 1000 });
    expect((await request(admin, 'POST', '/migrations/background/missing/pause')).status).toBe(404);

    const audits = await pool.db
      .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, 'test.admin-probe'))
      .orderBy(schema.auditLog.createdAt);
    expect(audits.map((entry) => entry.action)).toEqual([
      'background_migration.pause',
      'background_migration.resume',
      'background_migration.update',
    ]);
    expect(audits[2]!.metadata).toEqual({ batchSize: 250, pauseMs: 1000 });
  });

  it('reports a new database as a rolling install', async () => {
    const other = await createLiveDatabase('admin_migrations_fresh');
    const fresh = createDatabase(other.connectionString, { max: 1 });
    try {
      await fresh.db.execute(sql`drop schema drizzle cascade`);
      const report = await upgradeReport(fresh.sql, { definitions: [] });
      expect(report.database.fresh).toBe(true);
      expect(report.preDeploy.length).toBeGreaterThan(30);
      expect(report.verdict.mode).toBe('rolling');
      expect(report.verdict.reasons[0]).toMatch(/A new database/);
      expect(renderReport(report)).toMatch(/new database, never migrated/);
    } finally {
      await fresh.sql.end({ timeout: 1 });
      await other.destroy();
    }
  });
});
