import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, schema } from '@oci/db';
import type { InstanceSettings, SearchTestResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Web search fallback (v0.10) end to end: settings saved through the admin
 * API into a real database, searches made over real HTTP to stub provider
 * servers. SearXNG stubs answer at their own addresses; Brave Search's fixed
 * endpoint is redirected to a stub, so its key travels in the real header.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  logs: [] as unknown[],
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => {
  const record = (...args: unknown[]) => {
    state.logs.push(args);
  };
  return { logger: { warn: record, info: record, error: record, debug: record } };
});

const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { searchWeb } = await import('../../services/search/index.js');
const { webSearches } = await import('../../services/observability/metrics.js');
const { resetMetrics } = await import('../../services/observability/metrics.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const QUERY = 'library opening hours kestrel';
const BRAVE_KEY = 'brave-fallback-secret-key';

type Behaviour = 'ok' | 'server-error' | 'unauthorized';
const stub = {
  primary: 'ok' as Behaviour,
  fallback: 'ok' as Behaviour,
  brave: 'ok' as Behaviour,
  hits: { primary: 0, fallback: 0, brave: 0 },
  braveKeys: [] as string[],
};

function answer(response: ServerResponse, behaviour: Behaviour, body: unknown) {
  if (behaviour === 'server-error') {
    response.writeHead(503).end('unavailable');
    return;
  }
  if (behaviour === 'unauthorized') {
    response.writeHead(401).end('no');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** SearXNG serves `/search` at the root of its address, so each stub has its own port. */
function searxngStub(slot: 'primary' | 'fallback') {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (new URL(request.url ?? '/', 'http://stub').pathname !== '/search') {
      response.writeHead(404).end();
      return;
    }
    stub.hits[slot] += 1;
    answer(response, stub[slot], {
      results: [{ title: slot, url: `https://${slot}.test/`, content: 'Snippet' }],
    });
  };
}

function braveStub(request: IncomingMessage, response: ServerResponse) {
  if (new URL(request.url ?? '/', 'http://stub').pathname !== '/res/v1/web/search') {
    response.writeHead(404).end();
    return;
  }
  stub.hits.brave += 1;
  stub.braveKeys.push(String(request.headers['x-subscription-token'] ?? ''));
  const known = request.headers['x-subscription-token'] === BRAVE_KEY;
  answer(response, known ? stub.brave : 'unauthorized', {
    web: { results: [{ title: 'brave', url: 'https://brave.test/', description: 'Snippet' }] },
  });
}

async function listen(handler?: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function adminApp(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Search admin',
      email: 'search-admin@example.test',
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

describe.skipIf(!available)('live: web search fallback provider', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let servers: Server[] = [];
  let primaryOrigin = '';
  let fallbackOrigin = '';
  let braveOrigin = '';
  /** An address where nothing listens. */
  let closedOrigin = '';
  const realFetch = globalThis.fetch;

  async function send(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function patchSearch(search: Record<string, unknown>) {
    const response = await send('PATCH', '/settings', { search });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  async function storedSearch() {
    const [row] = await live.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(
        and(
          eq(schema.instanceSetting.organizationId, state.organizationId),
          eq(schema.instanceSetting.key, 'search'),
        ),
      );
    return row?.value as Record<string, unknown>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('search_fallback');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    app = adminApp(await seedUser(live.db, state.organizationId, { role: 'admin' }));
    const primary = await listen(searxngStub('primary'));
    const fallback = await listen(searxngStub('fallback'));
    const brave = await listen(braveStub);
    const closed = await listen();
    servers = [primary.server, fallback.server, brave.server];
    primaryOrigin = primary.origin;
    fallbackOrigin = fallback.origin;
    braveOrigin = brave.origin;
    closedOrigin = closed.origin;
    await new Promise((resolve) => closed.server.close(resolve));
    // Brave Search has a fixed endpoint: send it to the stub, over real HTTP.
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'api.search.brave.com')
        return realFetch(`${braveOrigin}${url.pathname}${url.search}`, init);
      return realFetch(input, init);
    });
    const features = await send('PATCH', '/settings', {
      features: {
        shareLinks: true,
        temporaryChat: true,
        webSearch: true,
        attachments: true,
        branching: true,
      },
    });
    expect(features.status).toBe(200);
  });
  beforeEach(() => {
    stub.primary = 'ok';
    stub.fallback = 'ok';
    stub.brave = 'ok';
    stub.hits = { primary: 0, fallback: 0, brave: 0 };
    stub.braveKeys = [];
    state.logs = [];
    resetMetrics();
  });
  afterEach(() => {
    // Every log line of a search names providers and outcomes, never the query or a key.
    const logged = JSON.stringify(state.logs);
    expect(logged).not.toContain(QUERY);
    expect(logged).not.toContain(BRAVE_KEY);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    invalidateSettingsCache();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await live?.destroy();
  });

  it('stores the fallback key encrypted and never returns it', async () => {
    await patchSearch({
      enabled: true,
      maxResults: 5,
      provider: 'searxng',
      baseUrl: primaryOrigin,
      fallbackProvider: 'brave',
      fallbackApiKey: BRAVE_KEY,
      fallbackBaseUrl: 'https://not-used.example',
    });
    const stored = await storedSearch();
    expect(stored).toMatchObject({ fallbackProvider: 'brave', fallbackBaseUrl: null });
    expect(typeof stored.encryptedFallbackApiKey).toBe('string');
    expect(JSON.stringify(stored)).not.toContain(BRAVE_KEY);

    const response = await send('GET', '/settings');
    const body = (await response.json()) as InstanceSettings;
    expect(body.search).toMatchObject({
      provider: 'searxng',
      fallbackProvider: 'brave',
      fallbackBaseUrl: null,
      hasFallbackCredential: true,
    });
    expect(JSON.stringify(body)).not.toContain(BRAVE_KEY);

    // The audit entry shows that the key changed, not what it is.
    const audits = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'));
    expect(JSON.stringify(audits)).not.toContain(BRAVE_KEY);
  });

  it('answers from the first provider when it works, without touching the fallback', async () => {
    const answer = await searchWeb(QUERY);
    expect(answer).toEqual({
      results: [{ title: 'primary', url: 'https://primary.test/', snippet: 'Snippet' }],
      provider: 'SearXNG',
      fallback: false,
    });
    expect(stub.hits).toEqual({ primary: 1, fallback: 0, brave: 0 });
    expect(webSearches.get({ provider: 'searxng', slot: 'primary', outcome: 'answered' })).toBe(1);
  });

  it('retries a server error once, then falls back and says which provider answered', async () => {
    stub.primary = 'server-error';
    const answer = await searchWeb(QUERY);
    expect(answer).toMatchObject({ provider: 'Brave Search', fallback: true });
    expect(answer.results).toEqual([
      { title: 'brave', url: 'https://brave.test/', snippet: 'Snippet' },
    ]);
    expect(stub.hits).toEqual({ primary: 2, fallback: 0, brave: 1 });
    expect(stub.braveKeys).toEqual([BRAVE_KEY]);
    expect(webSearches.get({ provider: 'searxng', slot: 'primary', outcome: 'failed' })).toBe(1);
    expect(webSearches.get({ provider: 'brave', slot: 'fallback', outcome: 'answered' })).toBe(1);
    expect(JSON.stringify(state.logs)).toContain('Web search falling back to the second provider');
  });

  it('falls back when the first provider cannot be reached', async () => {
    await patchSearch({ baseUrl: closedOrigin });
    try {
      await expect(searchWeb(QUERY)).resolves.toMatchObject({
        provider: 'Brave Search',
        fallback: true,
      });
      expect(stub.hits.brave).toBe(1);
    } finally {
      await patchSearch({ baseUrl: primaryOrigin });
    }
  });

  it('names both providers when both fail', async () => {
    stub.primary = 'server-error';
    stub.brave = 'server-error';
    await expect(searchWeb(QUERY)).rejects.toThrow(
      'SearXNG returned an error (HTTP 503). The fallback provider failed too: Brave Search returned an error (HTTP 503).',
    );
    expect(stub.hits).toEqual({ primary: 2, fallback: 0, brave: 2 });
    expect(webSearches.get({ provider: 'brave', slot: 'fallback', outcome: 'failed' })).toBe(1);
  });

  it('does not fall back on an error the administrator must fix', async () => {
    stub.primary = 'unauthorized';
    await expect(searchWeb(QUERY)).rejects.toThrow(
      'SearXNG rejected the web search API key (HTTP 401)',
    );
    expect(stub.hits).toEqual({ primary: 1, fallback: 0, brave: 0 });
  });

  it('uses another SearXNG as the fallback, but not the same address', async () => {
    await patchSearch({ fallbackProvider: 'searxng', fallbackBaseUrl: fallbackOrigin });
    expect(await storedSearch()).toMatchObject({
      fallbackProvider: 'searxng',
      fallbackBaseUrl: fallbackOrigin,
      encryptedFallbackApiKey: null,
    });
    stub.primary = 'server-error';
    await expect(searchWeb(QUERY)).resolves.toMatchObject({ provider: 'SearXNG', fallback: true });
    expect(stub.hits).toEqual({ primary: 2, fallback: 1, brave: 0 });

    const same = await send('PATCH', '/settings', {
      search: { fallbackBaseUrl: primaryOrigin },
    });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('The fallback SearXNG must be at a different address.');
    expect(await storedSearch()).toMatchObject({ fallbackBaseUrl: fallbackOrigin });
  });

  it('refuses the same hosted service as its own fallback', async () => {
    await patchSearch({ provider: 'brave', apiKey: BRAVE_KEY });
    const same = await send('PATCH', '/settings', { search: { fallbackProvider: 'brave' } });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('Choose a different service as the fallback provider.');
    await patchSearch({ provider: 'searxng', baseUrl: primaryOrigin });
  });

  it('is not used while it lacks what it needs, and can be removed', async () => {
    await patchSearch({ fallbackProvider: 'brave' });
    // Switching provider drops the key that belonged to the previous one.
    expect(await storedSearch()).toMatchObject({
      fallbackProvider: 'brave',
      encryptedFallbackApiKey: null,
    });
    stub.primary = 'server-error';
    await expect(searchWeb(QUERY)).rejects.toThrow('SearXNG returned an error (HTTP 503).');
    expect(stub.hits.brave).toBe(0);

    await patchSearch({ fallbackProvider: null });
    expect(await storedSearch()).toMatchObject({
      fallbackProvider: null,
      fallbackBaseUrl: null,
      encryptedFallbackApiKey: null,
    });
  });

  it('tests both providers from the Web search page, with the saved fallback key', async () => {
    await patchSearch({ fallbackProvider: 'brave', fallbackApiKey: BRAVE_KEY });
    const response = await send('POST', '/settings/search/test', {
      provider: 'searxng',
      baseUrl: primaryOrigin,
      fallback: { provider: 'brave' },
    });
    expect(await response.json()).toEqual({
      ok: true,
      results: 1,
      fallback: { ok: true, results: 1 },
    } satisfies SearchTestResult);
    expect(stub.braveKeys).toEqual([BRAVE_KEY]);

    // Each is tested on its own: a failing first provider does not hide the fallback's result.
    stub.primary = 'unauthorized';
    const failing = await send('POST', '/settings/search/test', {
      provider: 'searxng',
      baseUrl: primaryOrigin,
      fallback: { provider: 'brave', apiKey: BRAVE_KEY },
    });
    const result = (await failing.json()) as SearchTestResult;
    expect(result).toMatchObject({ ok: false, fallback: { ok: true } });
    expect(result.message).toContain('SearXNG rejected the web search API key');

    // A typed key for another provider is never replaced by the saved Brave key.
    const other = await send('POST', '/settings/search/test', {
      provider: 'searxng',
      baseUrl: primaryOrigin,
      fallback: { provider: 'tavily' },
    });
    expect(((await other.json()) as SearchTestResult).fallback).toEqual({
      ok: false,
      message: 'Tavily needs an API key. Add it on the Web search page.',
    });

    const [audit] = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'search.test'))
      .limit(1);
    expect(audit?.metadata).toMatchObject({ provider: 'searxng', fallbackProvider: 'brave' });
  });
});
