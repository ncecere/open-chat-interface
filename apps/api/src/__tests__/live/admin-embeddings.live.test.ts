import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, DEFAULT_POST_FOLDER, eq, schema, sql } from '@oci/db';
import type { EmbeddingsStatus, EmbeddingsTestResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeEmbeddingModel, fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * The Embeddings administration API and its System health row, against real
 * PostgreSQL with pgvector available but, until a test enables it, not
 * enabled. The embeddings provider is a deterministic fake.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  fake: null as unknown,
  resolved: [] as string[],
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  sharedRedis: async () => null,
}));
vi.mock('../../services/embeddings/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/embeddings/model.js')>()),
  resolveEmbeddingModel: async (providerId: string, modelId: string) => {
    state.resolved.push(`${providerId}/${modelId}`);
    return state.fake;
  },
}));

const available = await livePostgresAvailable();
const { embeddingsRoutes } = await import('../../routes/admin/embeddings.js');
const { healthRoutes } = await import('../../routes/admin/health.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { resetPreviousReleaseCache } = await import('../../services/embeddings/generations.js');

function appFor(actorId: string, role: 'admin' | 'auditor') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Embeddings tester',
      email: `${role}-embeddings@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/embeddings', embeddingsRoutes);
  app.route('/health', healthRoutes);
  return app;
}

describe.skipIf(!available)('live: embeddings administration', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: Hono<AppBindings>;
  let auditor: Hono<AppBindings>;
  let openai: string;
  let claude: string;
  let fake: FakeEmbeddingModel;

  async function request(app: Hono<AppBindings>, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
  async function ok<T>(response: Response | Promise<Response>): Promise<T> {
    const resolved = await response;
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    return (await resolved.json()) as T;
  }
  const put = (body: unknown) => request(admin, 'PUT', '/embeddings', body);
  async function audits(action: string) {
    return pool.db
      .select({ metadata: schema.auditLog.metadata, actorUserId: schema.auditLog.actorUserId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }
  async function storedSetting() {
    const [row] = await pool.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(eq(schema.instanceSetting.key, 'embeddings'));
    return row?.value;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_embeddings');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = appFor(await seedUser(pool.db, state.organizationId, { role: 'admin' }), 'admin');
    auditor = appFor(await seedUser(pool.db, state.organizationId, { role: 'auditor' }), 'auditor');
    const providers = await pool.db
      .insert(schema.provider)
      .values([
        { organizationId: state.organizationId, kind: 'openai', label: 'OpenAI' },
        { organizationId: state.organizationId, kind: 'anthropic', label: 'Claude' },
        { organizationId: state.organizationId, kind: 'google', label: 'Off', enabled: false },
      ])
      .returning({ id: schema.provider.id, label: schema.provider.label });
    openai = providers.find((row) => row.label === 'OpenAI')!.id;
    claude = providers.find((row) => row.label === 'Claude')!.id;
  });
  beforeEach(() => {
    fake = fakeEmbeddingModel({ dimensions: 24 });
    state.fake = fake;
    state.resolved = [];
    invalidateSettingsCache();
  });
  /** Records this release's post-deploy steps as finished: every replica runs it. */
  async function finishUpgrade() {
    const journal = JSON.parse(readFileSync(join(DEFAULT_POST_FOLDER, 'journal.json'), 'utf8')) as {
      steps: Array<{ tag: string; release: string }>;
    };
    for (const step of journal.steps) {
      await pool.db.execute(sql`
        insert into oci_post_migration (name, checksum, started_at, finished_at, attempts)
        values (${step.tag}, 'test', now(), now(), 1)
        on conflict (name) do update set finished_at = now()
      `);
    }
    resetPreviousReleaseCache();
  }

  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('shows the state to administrators and auditors before anything is configured', async () => {
    for (const app of [admin, auditor]) {
      const status = await ok<EmbeddingsStatus>(request(app, 'GET', '/embeddings'));
      expect(status).toEqual({
        settings: {
          enabled: false,
          providerId: null,
          modelId: null,
          dimensions: null,
          inputPriceMicros: null,
        },
        pgvector: { state: 'available', version: null },
        // Anthropic cannot embed and a disabled provider is not offered.
        providers: [{ id: openai, label: 'OpenAI', kind: 'openai' }],
        active: false,
        storageDimensions: null,
        passages: { total: 0, embedded: 0 },
        failures: { files: 0, lastError: null },
        generations: { current: null, filling: null, retired: [], switchBlocked: null },
        estimate: { passages: 0, averageTokens: 0 },
      });
    }
    const health = await ok<{ checks: Array<{ id: string; status: string; detail: string }> }>(
      request(auditor, 'GET', '/health'),
    );
    expect(health.checks.find((check) => check.id === 'embeddings')).toEqual({
      id: 'embeddings',
      label: 'Meaning-based search',
      status: 'ok',
      detail: 'Off; keyword search only. pgvector installed but not enabled.',
    });
  });

  it('keeps auditors read-only', async () => {
    for (const [method, path] of [
      ['PUT', '/embeddings'],
      ['POST', '/embeddings/test'],
    ] as const) {
      const response = await request(auditor, method, path, {});
      expect(response.status).toBe(403);
    }
    expect(state.resolved).toEqual([]);
    expect(await storedSetting()).toBeUndefined();
  });

  it('tests a model by embedding a sample, storing nothing, and audits it', async () => {
    expect(
      await ok<EmbeddingsTestResult>(
        request(admin, 'POST', '/embeddings/test', { providerId: openai, modelId: 'small' }),
      ),
    ).toEqual({ ok: true, dimensions: 24 });
    expect(fake.embedded).toHaveLength(1);

    fake.failWith = new Error('unknown model');
    expect(
      await ok<EmbeddingsTestResult>(
        request(admin, 'POST', '/embeddings/test', { providerId: openai, modelId: 'nope' }),
      ),
    ).toEqual({ ok: false, message: 'The model could not embed a sample: unknown model' });
    // Nothing saved yet, so nothing to test without a model on the page.
    expect(await ok<EmbeddingsTestResult>(request(admin, 'POST', '/embeddings/test', {}))).toEqual({
      ok: false,
      message: 'The model could not embed a sample: Choose a provider and enter a model id first',
    });
    expect(await storedSetting()).toBeUndefined();
    expect((await audits('embeddings.test')).map((row) => row.metadata)).toEqual([
      { providerId: openai, modelId: 'small', ok: true, dimensions: 24 },
      {
        providerId: openai,
        modelId: 'nope',
        ok: false,
        reason: 'The model could not embed a sample: unknown model',
      },
      {
        providerId: null,
        modelId: null,
        ok: false,
        reason: 'The model could not embed a sample: Choose a provider and enter a model id first',
      },
    ]);
    expect((await request(admin, 'POST', '/embeddings/test', { extra: 1 })).status).toBe(422);
  });

  it('refuses settings that cannot work', async () => {
    expect((await put({ enabled: true })).status).toBe(422);
    expect((await put({ providerId: claude, modelId: 'x' })).status).toBe(422);
    expect((await put({ providerId: 'missing', modelId: 'x' })).status).toBe(422);
    expect((await put({ enabled: 'yes' })).status).toBe(422);
    fake.failWith = new Error('unknown model');
    const failing = await put({ enabled: true, providerId: openai, modelId: 'nope' });
    expect(failing.status).toBe(422);
    expect(((await failing.json()) as { error: { message: string } }).error.message).toBe(
      'The model could not embed a sample: unknown model',
    );
    expect(await storedSetting()).toBeUndefined();
    expect(await audits('embeddings.update')).toEqual([]);
  });

  it('saves a model with the dimensions it reports, and waits for pgvector', async () => {
    // A model saved while off is still measured; one that fails is saved unmeasured.
    fake.failWith = new Error('offline');
    let status = await ok<EmbeddingsStatus>(put({ providerId: openai, modelId: 'draft' }));
    expect(status.settings).toMatchObject({ enabled: false, modelId: 'draft', dimensions: null });
    fake.failWith = null;

    status = await ok<EmbeddingsStatus>(
      put({ enabled: true, modelId: 'text-embedding-3-small', inputPriceMicros: 20_000 }),
    );
    expect(status).toMatchObject({
      settings: {
        enabled: true,
        providerId: openai,
        modelId: 'text-embedding-3-small',
        dimensions: 24,
        inputPriceMicros: 20_000,
      },
      pgvector: { state: 'available' },
      active: false,
      storageDimensions: null,
    });
    const [table] = await pool.db.execute<{ found: string | null }>(
      sql`select to_regclass('project_file_embedding')::text as found`,
    );
    expect(table?.found).toBeNull();
    const health = await ok<{ checks: Array<{ id: string; status: string; detail: string }> }>(
      request(admin, 'GET', '/health'),
    );
    expect(health.checks.find((check) => check.id === 'embeddings')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('pgvector installed but not enabled'),
    });

    const updates = await audits('embeddings.update');
    expect(updates.at(-1)?.metadata).toEqual({
      previous: {
        enabled: false,
        providerId: openai,
        modelId: 'draft',
        dimensions: null,
        inputPriceMicros: null,
      },
      next: {
        enabled: true,
        providerId: openai,
        modelId: 'text-embedding-3-small',
        dimensions: 24,
        inputPriceMicros: 20_000,
      },
    });
    // Unchanged model: no new test embedding.
    state.resolved = [];
    await ok(put({ inputPriceMicros: null }));
    expect(state.resolved).toEqual([]);
  });

  it('creates storage once pgvector is enabled, and reports it on System health', async () => {
    await pool.db.execute(sql`create extension if not exists vector`);
    let status = await ok<EmbeddingsStatus>(request(admin, 'GET', '/embeddings'));
    expect(status).toMatchObject({
      pgvector: { state: 'enabled', version: expect.stringMatching(/^\d+\.\d+/) },
      active: false,
    });
    expect(
      (
        await ok<{ checks: Array<{ id: string; status: string; detail: string }> }>(
          request(admin, 'GET', '/health'),
        )
      ).checks.find((check) => check.id === 'embeddings'),
    ).toMatchObject({ status: 'warn', detail: expect.stringContaining('not ready yet') });

    status = await ok<EmbeddingsStatus>(put({ enabled: true }));
    expect(status).toMatchObject({ active: true, storageDimensions: 24 });
    expect((await audits('embeddings.update')).at(-1)?.metadata).toMatchObject({
      storage: 'created',
    });
    expect(
      (
        await ok<{ checks: Array<{ id: string; status: string; detail: string }> }>(
          request(auditor, 'GET', '/health'),
        )
      ).checks.find((check) => check.id === 'embeddings'),
    ).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^On \(pgvector .+ enabled\)\. 0 of 0 passages embedded/),
    });

    // A model of other dimensions is a new generation, filled in the
    // background while searches keep using the current one.
    fake = fakeEmbeddingModel({ dimensions: 8 });
    state.fake = fake;
    status = await ok<EmbeddingsStatus>(put({ modelId: 'tiny', inputPriceMicros: 20_000 }));
    expect(status).toMatchObject({
      settings: { modelId: 'tiny', dimensions: 8, inputPriceMicros: 20_000 },
      active: true,
      storageDimensions: 24,
      generations: {
        current: { id: 1, modelId: 'text-embedding-3-small', dimensions: 24, state: 'current' },
        filling: { id: 2, modelId: 'tiny', dimensions: 8, state: 'filling', storageReady: true },
        retired: [],
        // The test database records no post-deploy step: as during an upgrade.
        switchBlocked: 'upgrade-in-progress',
      },
    });
    expect((await audits('embeddings.update')).at(-1)?.metadata).toMatchObject({
      storage: 'created',
      rebuild: 'started',
      generation: 2,
      estimate: { passages: 0, averageTokens: 0, costMicros: 0 },
    });
    // The setting v0.10 replicas read still describes what searches use.
    expect(await storedSetting()).toMatchObject({
      modelId: 'text-embedding-3-small',
      dimensions: 24,
    });
    const [tables] = await pool.db.execute<{ first: string | null; second: string | null }>(
      sql`select to_regclass('project_file_embedding')::text as first,
                 to_regclass('project_file_embedding_g2')::text as second`,
    );
    expect(tables).toEqual({
      first: 'project_file_embedding',
      second: 'project_file_embedding_g2',
    });

    // Switching off keeps the stored vectors for later.
    status = await ok<EmbeddingsStatus>(put({ enabled: false }));
    expect(status).toMatchObject({ active: false, storageDimensions: 24 });
    await ok(put({ enabled: true }));
  });

  it('switches to the new generation only once the upgrade is over, and audits it', async () => {
    // Auditors cannot switch or cancel.
    for (const action of ['switch', 'cancel']) {
      expect(
        (await request(auditor, 'POST', `/embeddings/generations/2/${action}`, {})).status,
      ).toBe(403);
    }
    // Generation 1's table is the one v0.10 replicas use: no switch until
    // this release's post-deploy steps are recorded.
    const response = await request(admin, 'POST', '/embeddings/generations/2/switch', {});
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /migrate --post/,
    );
    expect((await request(admin, 'POST', '/embeddings/generations/9/switch', {})).status).toBe(409);
    expect((await request(admin, 'POST', '/embeddings/generations/x/switch', {})).status).toBe(404);
    expect(
      (await request(admin, 'POST', '/embeddings/generations/2/switch', { force: 'yes' })).status,
    ).toBe(422);

    await finishUpgrade();
    const status = await ok<EmbeddingsStatus>(
      request(admin, 'POST', '/embeddings/generations/2/switch', {}),
    );
    expect(status).toMatchObject({
      settings: { modelId: 'tiny', dimensions: 8 },
      active: true,
      storageDimensions: 8,
      generations: {
        current: { id: 2, modelId: 'tiny', state: 'current' },
        filling: null,
        retired: [{ id: 1, state: 'retired', modelId: 'text-embedding-3-small' }],
        switchBlocked: null,
      },
    });
    const dropAfter = new Date(status.generations.retired[0]!.dropAfter!).getTime();
    // The default grace period: a day.
    expect(dropAfter - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(await storedSetting()).toMatchObject({ modelId: 'tiny', dimensions: 8, enabled: true });
    expect((await audits('embeddings.generation.switch')).at(-1)?.metadata).toEqual({
      generation: 2,
      providerId: openai,
      modelId: 'tiny',
      dimensions: 8,
      previous: 1,
      passages: { total: 0, embedded: 0 },
      forced: false,
      automatic: false,
    });
  });

  it('cancels a rebuild, and goes back to the current model when it is chosen again', async () => {
    fake = fakeEmbeddingModel({ dimensions: 12 });
    state.fake = fake;
    let status = await ok<EmbeddingsStatus>(put({ modelId: 'medium' }));
    expect(status.generations.filling).toMatchObject({ id: 3, modelId: 'medium' });
    status = await ok<EmbeddingsStatus>(
      request(admin, 'POST', '/embeddings/generations/3/cancel', {}),
    );
    expect(status).toMatchObject({
      settings: { modelId: 'tiny', dimensions: 8 },
      generations: { current: { id: 2 }, filling: null },
    });
    expect((await audits('embeddings.generation.cancel')).at(-1)?.metadata).toMatchObject({
      generation: 3,
      modelId: 'medium',
    });
    expect((await request(admin, 'POST', '/embeddings/generations/3/cancel', {})).status).toBe(409);

    // Choosing the current model again while a rebuild runs cancels it too.
    status = await ok<EmbeddingsStatus>(put({ modelId: 'medium' }));
    expect(status.generations.filling).toMatchObject({ id: 3, modelId: 'medium' });
    fake = fakeEmbeddingModel({ dimensions: 8 });
    state.fake = fake;
    status = await ok<EmbeddingsStatus>(put({ modelId: 'tiny' }));
    expect(status.generations).toMatchObject({ current: { id: 2 }, filling: null });
    expect((await audits('embeddings.update')).at(-1)?.metadata).toMatchObject({
      rebuild: 'cancelled',
      generation: 2,
    });
    // A model that cannot embed cannot replace the one in use, even while off.
    fake.failWith = new Error('gone');
    expect((await put({ enabled: false, modelId: 'broken' })).status).toBe(422);
    // Nor can the model be removed while embeddings are stored for it.
    expect((await put({ enabled: false, modelId: null })).status).toBe(422);
  });
});
