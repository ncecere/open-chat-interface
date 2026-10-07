import { createDatabase, eq, schema } from '@oci/db';
import type { RerankingStatus, RerankingTestResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeReranker, startFakeReranker } from '../../../test/fake-reranker.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * The Reranking administration API against real PostgreSQL and a
 * Cohere-compatible reranking server on 127.0.0.1.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
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

const available = await livePostgresAvailable();
const { rerankingRoutes } = await import('../../routes/admin/reranking.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { encryptSecret } = await import('../../lib/crypto.js');

const KEY = 'sk-admin-rerank-key';

function appFor(actorId: string, role: 'admin' | 'auditor') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Reranking tester',
      email: `${role}-reranking@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/reranking', rerankingRoutes);
  return app;
}

describe.skipIf(!available)('live: reranking administration', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: Hono<AppBindings>;
  let auditor: Hono<AppBindings>;
  let server: FakeReranker;
  const ids: Record<string, string> = {};

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
  const put = (body: unknown) => request(admin, 'PUT', '/reranking', body);
  const test = (body: unknown = {}) =>
    ok<RerankingTestResult>(request(admin, 'POST', '/reranking/test', body));
  async function audits(action: string) {
    return pool.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }
  async function storedSetting() {
    const [row] = await pool.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(eq(schema.instanceSetting.key, 'reranking'));
    return row?.value;
  }
  async function errorMessage(response: Response) {
    return ((await response.json()) as { error: { message: string } }).error.message;
  }

  beforeAll(async () => {
    server = await startFakeReranker();
    live = await createLiveDatabase('admin_reranking');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = appFor(await seedUser(pool.db, state.organizationId, { role: 'admin' }), 'admin');
    auditor = appFor(await seedUser(pool.db, state.organizationId, { role: 'auditor' }), 'auditor');
    const rows = await pool.db
      .insert(schema.provider)
      .values([
        {
          organizationId: state.organizationId,
          kind: 'openai-compatible',
          label: 'Local',
          baseUrl: `${server.baseUrl}/`,
          encryptedApiKey: encryptSecret(KEY),
        },
        {
          organizationId: state.organizationId,
          kind: 'openai',
          label: 'Gateway',
          baseUrl: 'https://litellm.example/v1',
          encryptedApiKey: encryptSecret('gateway-key'),
        },
        { organizationId: state.organizationId, kind: 'openai', label: 'OpenAI' },
        {
          organizationId: state.organizationId,
          kind: 'anthropic',
          label: 'Claude',
          baseUrl: 'https://api.anthropic.com/v1',
        },
        {
          organizationId: state.organizationId,
          kind: 'google',
          label: 'Gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
        {
          organizationId: state.organizationId,
          kind: 'openai-compatible',
          label: 'Off',
          baseUrl: 'http://127.0.0.1:9/v1',
          enabled: false,
        },
        {
          organizationId: state.organizationId,
          kind: 'openai',
          label: 'Keyless gateway',
          baseUrl: 'https://keyless.example/v1',
        },
      ])
      .returning({ id: schema.provider.id, label: schema.provider.label });
    for (const row of rows) ids[row.label] = row.id;
  });
  beforeEach(() => {
    server.mode = 'ok';
    server.maxResults = null;
    server.requests.length = 0;
    invalidateSettingsCache();
  });
  afterAll(async () => {
    await server?.close();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('shows the state and the resolved endpoints to administrators and auditors', async () => {
    for (const app of [admin, auditor]) {
      const status = await ok<RerankingStatus>(request(app, 'GET', '/reranking'));
      expect(status).toEqual({
        settings: { enabled: false, providerId: null, modelId: null, searchPriceMicros: null },
        // Anthropic, Google, OpenAI without a base URL and disabled providers cannot rerank.
        providers: [
          {
            id: ids.Gateway,
            label: 'Gateway',
            kind: 'openai',
            endpoint: 'https://litellm.example/v1/rerank',
          },
          {
            id: ids['Keyless gateway'],
            label: 'Keyless gateway',
            kind: 'openai',
            endpoint: 'https://keyless.example/v1/rerank',
          },
          {
            id: ids.Local,
            label: 'Local',
            kind: 'openai-compatible',
            endpoint: `${server.baseUrl}/rerank`,
          },
        ],
        endpoint: null,
        active: false,
      });
      expect(JSON.stringify(status)).not.toContain(KEY);
    }
  });

  it('keeps auditors read-only', async () => {
    for (const [method, path] of [
      ['PUT', '/reranking'],
      ['POST', '/reranking/test'],
    ] as const) {
      expect((await request(auditor, method, path, {})).status).toBe(403);
    }
    expect(server.requests).toEqual([]);
    expect(await storedSetting()).toBeUndefined();
    expect(await audits('reranking.test')).toEqual([]);
  });

  it('tests a model by reranking a sample, reporting latency, and audits it', async () => {
    const worked = await test({ providerId: ids.Local, modelId: 'bge-reranker-v2-m3' });
    expect(worked).toEqual({
      ok: true,
      latencyMs: expect.any(Number),
      endpoint: `${server.baseUrl}/rerank`,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      path: '/v1/rerank',
      authorization: `Bearer ${KEY}`,
      body: { model: 'bge-reranker-v2-m3', top_n: 3 },
    });
    expect(server.requests[0]!.body.documents).toHaveLength(3);

    // A server that answers with no scores is not a working reranker.
    server.maxResults = 0;
    expect(await test({ providerId: ids.Local, modelId: 'empty' })).toEqual({
      ok: false,
      message: 'The model could not rerank a sample: Local returned no reranking results',
    });
    server.maxResults = null;

    server.mode = 'error';
    expect(await test({ providerId: ids.Local, modelId: 'missing' })).toEqual({
      ok: false,
      message:
        'The model could not rerank a sample: Local returned an error while reranking (HTTP 500).',
    });
    expect(await test({ providerId: ids['Keyless gateway'], modelId: 'x' })).toEqual({
      ok: false,
      message: 'The model could not rerank a sample: Keyless gateway has no API key configured',
    });
    expect(await test({ providerId: ids.Claude, modelId: 'x' })).toEqual({
      ok: false,
      message:
        'The model could not rerank a sample: Claude cannot rerank: it needs an OpenAI-compatible base URL',
    });
    expect(await test({ providerId: ids.Off, modelId: 'x' })).toEqual({
      ok: false,
      message: 'The model could not rerank a sample: Off is disabled',
    });
    expect(await test({ providerId: 'gone', modelId: 'x' })).toEqual({
      ok: false,
      message: 'The model could not rerank a sample: The reranking provider no longer exists',
    });
    // Nothing saved yet, so nothing to test without a model on the page.
    expect(await test()).toEqual({
      ok: false,
      message: 'The model could not rerank a sample: Choose a provider and enter a model id first',
    });
    expect(await storedSetting()).toBeUndefined();
    const tests = (await audits('reranking.test')).map((row) => row.metadata);
    expect(tests[0]).toEqual({
      providerId: ids.Local,
      modelId: 'bge-reranker-v2-m3',
      ok: true,
      latencyMs: expect.any(Number),
      endpoint: `${server.baseUrl}/rerank`,
    });
    expect(tests.slice(1)).toEqual([
      { providerId: ids.Local, modelId: 'empty', ok: false, reason: expect.any(String) },
      { providerId: ids.Local, modelId: 'missing', ok: false, reason: expect.any(String) },
      {
        providerId: ids['Keyless gateway'],
        modelId: 'x',
        ok: false,
        reason: 'The model could not rerank a sample: Keyless gateway has no API key configured',
      },
      { providerId: ids.Claude, modelId: 'x', ok: false, reason: expect.any(String) },
      {
        providerId: ids.Off,
        modelId: 'x',
        ok: false,
        reason: 'The model could not rerank a sample: Off is disabled',
      },
      {
        providerId: 'gone',
        modelId: 'x',
        ok: false,
        reason: 'The model could not rerank a sample: The reranking provider no longer exists',
      },
      {
        providerId: null,
        modelId: null,
        ok: false,
        reason: 'The model could not rerank a sample: Choose a provider and enter a model id first',
      },
    ]);
    expect(JSON.stringify(tests)).not.toContain(KEY);
    expect((await request(admin, 'POST', '/reranking/test', { extra: 1 })).status).toBe(422);
  });

  it('refuses settings that cannot work', async () => {
    expect((await put({ enabled: true })).status).toBe(422);
    for (const label of ['Claude', 'Gemini', 'OpenAI']) {
      const refused = await put({ providerId: ids[label], modelId: 'x' });
      expect(refused.status).toBe(422);
      expect(await errorMessage(refused)).toContain('That provider cannot rerank');
    }
    expect((await put({ providerId: 'missing', modelId: 'x' })).status).toBe(422);
    expect((await put({ searchPriceMicros: -1 })).status).toBe(422);
    server.mode = 'error';
    const failing = await put({ enabled: true, providerId: ids.Local, modelId: 'x' });
    expect(failing.status).toBe(422);
    expect(await errorMessage(failing)).toBe(
      'The model could not rerank a sample: Local returned an error while reranking (HTTP 500).',
    );
    expect(await storedSetting()).toBeUndefined();
    expect(await audits('reranking.update')).toEqual([]);
  });

  it('saves a model after reranking a sample, and audits every change', async () => {
    // Off: saved untested.
    let status = await ok<RerankingStatus>(put({ providerId: ids.Local, modelId: 'draft' }));
    expect(status).toMatchObject({
      settings: { enabled: false, providerId: ids.Local, modelId: 'draft' },
      endpoint: `${server.baseUrl}/rerank`,
      active: false,
    });
    expect(server.requests).toEqual([]);

    status = await ok<RerankingStatus>(
      put({ enabled: true, modelId: 'bge-reranker-v2-m3', searchPriceMicros: 2_000_000 }),
    );
    expect(status).toMatchObject({
      settings: {
        enabled: true,
        providerId: ids.Local,
        modelId: 'bge-reranker-v2-m3',
        searchPriceMicros: 2_000_000,
      },
      endpoint: `${server.baseUrl}/rerank`,
      active: true,
    });
    expect(server.requests).toHaveLength(1);
    expect((await audits('reranking.update')).map((row) => row.metadata)).toEqual([
      {
        previous: { enabled: false, providerId: null, modelId: null, searchPriceMicros: null },
        next: { enabled: false, providerId: ids.Local, modelId: 'draft', searchPriceMicros: null },
      },
      {
        previous: {
          enabled: false,
          providerId: ids.Local,
          modelId: 'draft',
          searchPriceMicros: null,
        },
        next: {
          enabled: true,
          providerId: ids.Local,
          modelId: 'bge-reranker-v2-m3',
          searchPriceMicros: 2_000_000,
        },
        latencyMs: expect.any(Number),
      },
    ]);

    // An unchanged model is not tested again, even while the server is down.
    server.mode = 'error';
    status = await ok<RerankingStatus>(put({ searchPriceMicros: null }));
    expect(status.settings.searchPriceMicros).toBeNull();
    expect(server.requests).toHaveLength(1);

    // Turning it off needs no test either; the provider stays chosen.
    status = await ok<RerankingStatus>(put({ enabled: false }));
    expect(status).toMatchObject({ active: false, endpoint: `${server.baseUrl}/rerank` });
    // A disabled provider shows no endpoint.
    await pool.db
      .update(schema.provider)
      .set({ enabled: false })
      .where(eq(schema.provider.id, ids.Local!));
    status = await ok<RerankingStatus>(request(auditor, 'GET', '/reranking'));
    expect(status.endpoint).toBeNull();
    expect(JSON.stringify(await audits('reranking.update'))).not.toContain(KEY);
  });
});
