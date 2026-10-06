import { and, eq, schema } from '@oci/db';
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

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { modelRoutes } = await import('../../routes/admin/models.js');
const { reportRoutes } = await import('../../routes/admin/reports.js');
const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function adminApp(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Partial update admin',
      email: 'partial-admin@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/models', modelRoutes);
  app.route('/reports', reportRoutes);
  app.route('/settings', settingsRoutes);
  return app;
}

async function send(app: Hono<AppBindings>, method: string, path: string, body: unknown) {
  const response = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response;
}

/**
 * The admin UI sends one field at a time. These cases reproduce a write that
 * filled unsent fields with schema defaults and overwrote stored values.
 */
describe.skipIf(!available)('live: partial administrative updates', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let providerId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_partial');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    app = adminApp(await seedUser(live.db, state.organizationId, { role: 'admin' }));
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'No requests' })
      .returning();
    providerId = provider!.id;
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('changes only the sent model field', async () => {
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId,
        slug: 'partial-model',
        upstreamModelId: 'partial-model',
        displayName: 'Partial model',
        capabilities: ['vision', 'reasoning'],
        supportedEfforts: ['low', 'high'],
        visibleToRoles: ['admin'],
        isDefault: true,
        sortOrder: 7,
      })
      .returning();

    await send(app, 'PATCH', `/models/${model!.id}`, { enabled: false });
    await send(app, 'PATCH', `/models/${model!.id}`, { displayName: 'Renamed model' });

    const [stored] = await live.db
      .select()
      .from(schema.model)
      .where(eq(schema.model.id, model!.id));
    expect(stored).toMatchObject({
      enabled: false,
      displayName: 'Renamed model',
      capabilities: ['vision', 'reasoning'],
      supportedEfforts: ['low', 'high'],
      visibleToRoles: ['admin'],
      isDefault: true,
      sortOrder: 7,
    });
  });

  it('sets, clears and audits the context window and output limit', async () => {
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId,
        slug: 'limits-model',
        upstreamModelId: 'limits-model',
        displayName: 'Limits model',
      })
      .returning();
    const stored = async () => {
      const [row] = await live.db
        .select({
          contextWindow: schema.model.contextWindow,
          maxOutputTokens: schema.model.maxOutputTokens,
        })
        .from(schema.model)
        .where(eq(schema.model.id, model!.id));
      return row;
    };

    await send(app, 'PATCH', `/models/${model!.id}`, {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(await stored()).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000 });

    const [audit] = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'model.update'), eq(schema.auditLog.targetId, model!.id)),
      );
    expect(audit?.metadata).toEqual({ fields: ['contextWindow', 'maxOutputTokens'] });

    // Blank in the form: unknown again, so the fallback applies.
    await send(app, 'PATCH', `/models/${model!.id}`, {
      contextWindow: null,
      maxOutputTokens: null,
    });
    expect(await stored()).toEqual({ contextWindow: null, maxOutputTokens: null });
  });

  it('refuses an output limit that leaves no room for input', async () => {
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId,
        slug: 'tight-model',
        upstreamModelId: 'tight-model',
        displayName: 'Tight model',
        contextWindow: 8192,
      })
      .returning();
    const patch = (body: unknown) =>
      app.request(`/models/${model!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Against the stored window.
    let response = await patch({ maxOutputTokens: 8000 });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /below 7,680 tokens/,
    );
    // Against the assumed window when the window is cleared.
    response = await patch({ contextWindow: null, maxOutputTokens: 40_000 });
    expect(response.status).toBe(422);
    // Not an integer, or beyond the ceiling.
    expect((await patch({ contextWindow: 1.5 })).status).toBe(422);
    expect((await patch({ contextWindow: 20_000_000 })).status).toBe(422);
    expect((await patch({ maxOutputTokens: 0 })).status).toBe(422);

    const [row] = await live.db
      .select({
        contextWindow: schema.model.contextWindow,
        maxOutputTokens: schema.model.maxOutputTokens,
      })
      .from(schema.model)
      .where(eq(schema.model.id, model!.id));
    expect(row).toEqual({ contextWindow: 8192, maxOutputTokens: null });

    // Creating checks too.
    response = await app.request('/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId,
        upstreamModelId: 'new-tight',
        slug: 'new-tight',
        displayName: 'New tight',
        contextWindow: 4096,
        maxOutputTokens: 4096,
      }),
    });
    expect(response.status).toBe(422);
  });

  it('leaves exactly one default when defaults are changed concurrently', async () => {
    const created = await live.db
      .insert(schema.model)
      .values(
        Array.from({ length: 6 }, (_, index) => ({
          organizationId: state.organizationId,
          providerId,
          slug: `default-race-${index}`,
          upstreamModelId: `default-race-${index}`,
          displayName: `Default race ${index}`,
        })),
      )
      .returning({ id: schema.model.id });

    await Promise.all(
      created.map((row) => send(app, 'PATCH', `/models/${row.id}`, { isDefault: true })),
    );

    const defaults = await live.db
      .select({ id: schema.model.id })
      .from(schema.model)
      .where(
        and(
          eq(schema.model.organizationId, state.organizationId),
          eq(schema.model.isDefault, true),
        ),
      );
    expect(defaults).toHaveLength(1);
  });

  it('keeps the session lifetime when another setting is saved', async () => {
    await send(app, 'PATCH', '/settings', { sessionLifetimeDays: 14, sessionRefreshDays: 3 });
    await send(app, 'PATCH', '/settings', { colorTheme: 'blue' });

    const [auth] = await live.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(
        and(
          eq(schema.instanceSetting.organizationId, state.organizationId),
          eq(schema.instanceSetting.key, 'auth'),
        ),
      );
    expect(auth?.value).toMatchObject({ sessionLifetimeDays: 14, sessionRefreshDays: 3 });

    const [audit] = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'))
      .orderBy(schema.auditLog.createdAt)
      .offset(1)
      .limit(1);
    expect(audit?.metadata).toMatchObject({ keys: ['colorTheme'] });
  });

  it('caps the instance upload limit at 1 GiB (#142)', async () => {
    const storage = async () => {
      const [row] = await live.db
        .select({ value: schema.instanceSetting.value })
        .from(schema.instanceSetting)
        .where(
          and(
            eq(schema.instanceSetting.organizationId, state.organizationId),
            eq(schema.instanceSetting.key, 'storage'),
          ),
        );
      return row?.value as { maxFileBytes?: number } | undefined;
    };
    // 100,000 MB, which the walk saved as "97.66 GB per file".
    const refused = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storage: { maxFileBytes: 100_000 * 1024 * 1024 } }),
    });
    expect(refused.status).toBe(422);
    expect((await storage())?.maxFileBytes).not.toBe(100_000 * 1024 * 1024);

    await send(app, 'PATCH', '/settings', { storage: { maxFileBytes: 1024 * 1024 * 1024 } });
    expect((await storage())?.maxFileBytes).toBe(1024 * 1024 * 1024);
  });

  it('caps files per message at 20 and web search results at 20 (#218)', async () => {
    const stored = async (key: 'storage' | 'search') => {
      const [row] = await live.db
        .select({ value: schema.instanceSetting.value })
        .from(schema.instanceSetting)
        .where(
          and(
            eq(schema.instanceSetting.organizationId, state.organizationId),
            eq(schema.instanceSetting.key, key),
          ),
        );
      return row?.value as { maxFilesPerMessage?: number; maxResults?: number } | undefined;
    };
    const patch = (body: unknown) =>
      app.request('/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // The values the walk saved.
    expect((await patch({ storage: { maxFilesPerMessage: 100_000 } })).status).toBe(422);
    expect((await stored('storage'))?.maxFilesPerMessage).not.toBe(100_000);
    expect((await patch({ search: { maxResults: 500 } })).status).toBe(422);
    expect((await stored('search'))?.maxResults).not.toBe(500);

    await send(app, 'PATCH', '/settings', { storage: { maxFilesPerMessage: 20 } });
    expect((await stored('storage'))?.maxFilesPerMessage).toBe(20);
    await send(app, 'PATCH', '/settings', { search: { maxResults: 20 } });
    expect((await stored('search'))?.maxResults).toBe(20);
  });

  it('stores only what the search provider uses and drops a key when switching', async () => {
    async function stored() {
      const [row] = await live.db
        .select({ value: schema.instanceSetting.value })
        .from(schema.instanceSetting)
        .where(
          and(
            eq(schema.instanceSetting.organizationId, state.organizationId),
            eq(schema.instanceSetting.key, 'search'),
          ),
        );
      const value = row?.value as {
        provider: string;
        baseUrl: string | null;
        encryptedApiKey: string | null;
      };
      return {
        provider: value.provider,
        baseUrl: value.baseUrl,
        hasKey: Boolean(value.encryptedApiKey),
      };
    }
    const search = (body: Record<string, unknown>) =>
      send(app, 'PATCH', '/settings', { search: body });

    // A hosted provider uses a key and a fixed endpoint: an address is not kept.
    await search({ provider: 'tavily', apiKey: 'tvly-test', baseUrl: 'https://unused.example' });
    expect(await stored()).toEqual({ provider: 'tavily', baseUrl: null, hasKey: true });
    await search({ maxResults: 7 });
    expect(await stored()).toMatchObject({ hasKey: true });

    // Switching never carries one provider's key to another.
    await search({ provider: 'serpapi' });
    expect(await stored()).toEqual({ provider: 'serpapi', baseUrl: null, hasKey: false });
    await search({ apiKey: 'serpapi-test' });
    expect(await stored()).toMatchObject({ hasKey: true });

    // SearXNG uses an address and no key.
    await search({ provider: 'searxng', baseUrl: 'https://search.example.edu' });
    expect(await stored()).toEqual({
      provider: 'searxng',
      baseUrl: 'https://search.example.edu',
      hasKey: false,
    });
    await search({ apiKey: 'ignored' });
    expect(await stored()).toMatchObject({ hasKey: false });
  });

  it('keeps a report window when the report is paused', async () => {
    const created = await send(app, 'POST', '/reports', {
      name: 'Weekly usage',
      cadence: 'weekly',
      windowDays: 7,
      recipients: ['ops@example.test'],
    });
    const { id } = (await created.json()) as { id: string };

    await send(app, 'PATCH', `/reports/${id}`, { enabled: false });

    const [stored] = await live.db
      .select()
      .from(schema.scheduledReport)
      .where(eq(schema.scheduledReport.id, id));
    expect(stored).toMatchObject({ enabled: false, windowDays: 7, cadence: 'weekly' });
  });
});
