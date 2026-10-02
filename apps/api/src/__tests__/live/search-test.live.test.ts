import { eq, schema } from '@oci/db';
import type { SearchTestResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function appFor(actorId: string, role: 'admin' | 'auditor') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Search tester',
      email: `${role}-search@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/settings', settingsRoutes);
  return app;
}

/** Provider replies, faked at fetch so no search service is called. */
function provider(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const sentKey = (fetch: ReturnType<typeof provider>) =>
  new URL(String((fetch.mock.calls[0] as unknown as [URL])[0])).searchParams.get('api_key');

describe.skipIf(!available)('live: testing the web search provider', () => {
  let live: LiveDatabase;
  let admin: Hono<AppBindings>;
  let auditor: Hono<AppBindings>;

  async function post(app: Hono<AppBindings>, body: unknown) {
    return app.request('/settings/search/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function result(body: unknown): Promise<SearchTestResult> {
    const response = await post(admin, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as SearchTestResult;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('search_test');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = appFor(await seedUser(live.db, state.organizationId, { role: 'admin' }), 'admin');
    auditor = appFor(await seedUser(live.db, state.organizationId, { role: 'auditor' }), 'auditor');
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('reports a working provider with the key typed on the page, storing nothing', async () => {
    const fetch = provider(200, {
      organic_results: [{ title: 'Wikipedia', link: 'https://www.wikipedia.org/', snippet: 'x' }],
    });
    expect(await result({ provider: 'serpapi', apiKey: 'typed-key' })).toEqual({
      ok: true,
      results: 1,
    });
    expect(sentKey(fetch)).toBe('typed-key');
    const [stored] = await live.db
      .select()
      .from(schema.instanceSetting)
      .where(eq(schema.instanceSetting.key, 'search'));
    expect(stored).toBeUndefined();
  });

  it('says plainly when the provider rejects the key', async () => {
    provider(401, { error: 'Invalid API key.' });
    expect(await result({ provider: 'serpapi', apiKey: 'wrong' })).toEqual({
      ok: false,
      message:
        'SerpApi rejected the web search API key (HTTP 401). An administrator needs to check it on the Web search page.',
    });
  });

  it('uses the saved key only for the provider it was saved for', async () => {
    const save = await admin.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ search: { provider: 'serpapi', apiKey: 'saved-serpapi-key' } }),
    });
    expect(save.status).toBe(200);

    const fetch = provider(200, {
      organic_results: [{ title: 'Wikipedia', link: 'https://www.wikipedia.org/' }],
    });
    expect(await result({ provider: 'serpapi' })).toMatchObject({ ok: true });
    expect(sentKey(fetch)).toBe('saved-serpapi-key');

    const other = provider(200, { results: [] });
    expect(await result({ provider: 'tavily' })).toEqual({
      ok: false,
      message: 'Tavily needs an API key. Add it on the Web search page.',
    });
    expect(other).not.toHaveBeenCalled();
  });

  it('records each test in the audit log without the key', async () => {
    const rows = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'search.test'));
    expect(rows.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { provider: 'serpapi', ok: true },
        { provider: 'serpapi', ok: false },
        { provider: 'tavily', ok: false },
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain('key');
  });

  it('is not available to auditors', async () => {
    const fetch = provider(200, { organic_results: [] });
    expect((await post(auditor, { provider: 'serpapi', apiKey: 'x' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
