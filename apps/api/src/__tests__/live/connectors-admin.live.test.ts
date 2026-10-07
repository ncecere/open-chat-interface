import { eq, schema } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Connector,
  type ConnectorsContext,
  SHARED_SECRET,
  useConnectorsSuite,
} from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * MCP connector administration and network safety end to end: real PostgreSQL, the real
 * admin and connector routes, and an in-process MCP server on 127.0.0.1.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  settings: new Map<string, unknown>(),
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
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: ['tool_calling'],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
// Short limits so timeouts and oversize results are quick to provoke.
vi.mock('../../services/connectors/limits.js', () => ({
  CONNECTOR_LIMITS: {
    timeoutMs: 1_500,
    maxResponseBytes: 64 * 1024,
    maxResultChars: 2_000,
    maxTools: 200,
    maxSchemaChars: 64_000,
  },
}));
const defaults: Record<string, unknown> = {
  features: {
    webSearch: false,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  },
  search: { enabled: false, provider: null, baseUrl: null, encryptedApiKey: null, maxResults: 5 },
  chat: { defaultSystemPrompt: null },
  // The artifact tools (v0.9) have their own suite; keep this one's tool sets exact.
  roleFeatures: {
    roles: Object.fromEntries(
      ['admin', 'auditor', 'user', 'restricted'].map((role) => [role, { artifacts: false }]),
    ),
  },
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key] ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? defaults[key] ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  beginChatRun: async () => 'unavailable',
  sharedRedis: async () => null,
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live MCP connectors', () => {
  const suite = useConnectorsSuite(state);
  const { call, ok, createConnector, refresh, enable, getTools, allow, audits } = suite;
  let pool: ConnectorsContext['pool'];
  let admin: ConnectorsContext['admin'];
  let auditor: ConnectorsContext['auditor'];
  let alice: ConnectorsContext['alice'];
  let app: ConnectorsContext['app'];
  let mcp: ConnectorsContext['mcp'];
  beforeAll(() => {
    ({ pool, admin, auditor, alice, app } = suite.ctx);
  });
  beforeEach(() => {
    mcp = suite.ctx.mcp;
  });

  describe('administration', () => {
    it('stores a shared credential encrypted, never returns it, and audits metadata only', async () => {
      mcp.auth = { mode: 'header', header: { name: 'Authorization', value: SHARED_SECRET } };
      const created = await createConnector({
        authMode: 'shared',
        sharedHeaderValue: SHARED_SECRET,
      });
      expect(created).toMatchObject({
        slug: 'docs',
        authMode: 'shared',
        sharedHeaderName: 'Authorization',
        hasSharedCredential: true,
        allowPrivateNetwork: true,
      });
      const listed = await call('GET', '/api/admin/connectors');
      const [stored] = await pool.db.select().from(schema.connector);
      const auditRows = await audits('connector.create');
      for (const text of [
        JSON.stringify(created),
        await listed.text(),
        JSON.stringify(stored),
        JSON.stringify(auditRows),
      ])
        expect(text).not.toContain('SHARED-SECRET-VALUE-7731');
      expect(stored?.encryptedSharedHeaderValue).toEqual(expect.any(String));
      expect(auditRows[0]?.metadata).toMatchObject({
        slug: 'docs',
        authMode: 'shared',
        credential: 'set',
      });

      // The credential reaches the server, and only there.
      const test = await ok<{ ok: boolean; detail: string }>(
        call('POST', `/api/admin/connectors/${created.id}/test`),
      );
      expect(test).toEqual({ ok: true, detail: 'Connected to Test MCP 1.0.0 · 0 tools' });
      // Audited, as every Test button is (#287); the credential is not.
      const tests = await audits('connector.test');
      expect(tests.map((entry) => [entry.targetId, entry.metadata])).toEqual([
        [created.id, { slug: 'docs', url: created.url, ok: true }],
      ]);
      expect(JSON.stringify(tests)).not.toContain('Bearer');

      const updated = await ok<Connector>(
        call('PATCH', `/api/admin/connectors/${created.id}`, {
          body: { name: 'Team docs', sharedHeaderValue: 'Bearer ROTATED-SECRET-555' },
        }),
      );
      expect(updated).toMatchObject({ name: 'Team docs', slug: 'docs', hasSharedCredential: true });
      expect(JSON.stringify(updated)).not.toContain('ROTATED-SECRET-555');
      const [update] = await audits('connector.update');
      expect(update?.metadata).toMatchObject({
        fields: ['name'],
        sharedHeaderValue: 'replaced',
        oauthClientSecret: 'unchanged',
      });
      expect(JSON.stringify(update)).not.toContain('ROTATED-SECRET-555');
      // The rotated value is now what the server sees.
      expect(
        (await ok<{ ok: boolean }>(call('POST', `/api/admin/connectors/${created.id}/test`))).ok,
      ).toBe(false);
    });

    it('refuses unsafe addresses and header injection when saving', async () => {
      const refused = async (body: Record<string, unknown>) => {
        const response = await call('POST', '/api/admin/connectors', {
          body: { name: 'X', ...body },
        });
        expect(response.status, JSON.stringify(body)).toBe(422);
      };
      await refused({ url: mcp.url }); // plain http without the flag
      await refused({ url: 'https://10.0.0.5/mcp' });
      await refused({ url: 'https://[::1]/mcp' });
      await refused({ url: 'https://169.254.169.254/mcp', allowPrivateNetwork: true });
      await refused({ url: 'https://user:pass@mcp.example.test/mcp' });
      await refused({ url: 'ftp://mcp.example.test/' });
      await refused({ url: 'https://mcp.example.test/', authMode: 'shared' });
      await refused({
        url: 'https://mcp.example.test/',
        authMode: 'shared',
        sharedHeaderName: 'X-Key',
        sharedHeaderValue: 'abc\r\nX-Injected: 1',
      });
      await refused({
        url: 'https://mcp.example.test/',
        authMode: 'shared',
        sharedHeaderName: 'Host',
        sharedHeaderValue: 'abc',
      });
      await refused({
        url: 'https://mcp.example.test/',
        authMode: 'shared',
        sharedHeaderName: 'X Key:',
        sharedHeaderValue: 'abc',
      });
      expect(await pool.db.select().from(schema.connector)).toEqual([]);
    });

    it('gives each connector a unique slug and refuses a taken explicit one', async () => {
      const first = await createConnector({});
      const second = await createConnector({});
      expect([first.slug, second.slug]).toEqual(['docs', 'docs-2']);
      const taken = await call('POST', '/api/admin/connectors', {
        body: { name: 'Other', slug: 'docs', url: mcp.url, allowPrivateNetwork: true },
      });
      expect(taken.status).toBe(409);
    });

    it('lets auditors read connectors and change nothing', async () => {
      const connector = await createConnector({});
      expect((await call('GET', '/api/admin/connectors', { user: auditor })).status).toBe(200);
      expect(
        (await call('GET', `/api/admin/connectors/${connector.id}`, { user: auditor })).status,
      ).toBe(200);
      for (const [method, path, body] of [
        ['POST', '/api/admin/connectors', { name: 'X', url: 'https://x.example.test/' }],
        ['PATCH', `/api/admin/connectors/${connector.id}`, { name: 'Y' }],
        ['DELETE', `/api/admin/connectors/${connector.id}`, undefined],
        ['POST', `/api/admin/connectors/${connector.id}/test`, undefined],
        ['POST', `/api/admin/connectors/${connector.id}/refresh`, undefined],
      ] as const)
        expect(
          (await call(method, path, { user: auditor, body })).status,
          `${method} ${path}`,
        ).toBe(403);
      expect((await call('GET', '/api/admin/connectors', { user: alice })).status).toBe(403);
    });
  });

  describe('network safety', () => {
    it('refuses private addresses reached through a name, redirects, and plain http', async () => {
      const port = new URL(mcp.url).port;
      const viaName = await createConnector({
        url: `https://localhost:${port}/mcp`,
        allowPrivateNetwork: false,
      });
      const test = await ok<{ ok: boolean; detail: string }>(
        call('POST', `/api/admin/connectors/${viaName.id}/test`),
      );
      expect(test.ok).toBe(false);
      expect(test.detail).toContain('private or reserved network');

      const redirecting = await createConnector({ url: `${mcp.origin}/redirect` });
      const redirected = await ok<{ ok: boolean; detail: string }>(
        call('POST', `/api/admin/connectors/${redirecting.id}/test`),
      );
      expect(redirected).toMatchObject({ ok: false });
      expect(redirected.detail).toContain('redirect');

      // Turning the flag off later blocks plain http and loopback at the next connection.
      const flagged = await createConnector({});
      await pool.db
        .update(schema.connector)
        .set({ allowPrivateNetwork: false })
        .where(eq(schema.connector.id, flagged.id));
      const blocked = await ok<{ ok: boolean; detail: string }>(
        call('POST', `/api/admin/connectors/${flagged.id}/test`),
      );
      expect(blocked.ok).toBe(false);
      expect(blocked.detail).toContain('https://');
      const httpsLiteral = await createConnector({ url: `https://127.0.0.1:${port}/mcp` });
      await pool.db
        .update(schema.connector)
        .set({ allowPrivateNetwork: false })
        .where(eq(schema.connector.id, httpsLiteral.id));
      expect(
        (
          await ok<{ detail: string }>(
            call('POST', `/api/admin/connectors/${httpsLiteral.id}/test`),
          )
        ).detail,
      ).toContain('private or reserved network');
      // Only the redirect itself reached the test server.
      expect(mcp.requests.filter((request) => request.path !== '/redirect')).toEqual([]);
    });
  });

  it('deletes a connector with its tools, connections and role allows', async () => {
    mcp.auth = { mode: 'oauth' };
    mcp.tools = [{ name: 'search', annotations: { readOnlyHint: true } }];
    const connector = await createConnector({ authMode: 'oauth' });
    await connect_(connector.id);
    await refresh(connector);
    await enable({ ...connector, tools: await getTools(connector) }, 'search');
    await allow(['mcp__docs__search']);
    await allow(['mcp__docs__search'], 'admin');
    state.settings.set('roleTools', {
      roles: {
        ...(state.settings.get('roleTools') as { roles: object }).roles,
        restricted: { web_search: true },
      },
    });
    const response = await call('DELETE', `/api/admin/connectors/${connector.id}`);
    expect(response.status).toBe(200);
    expect(await pool.db.select().from(schema.connectorTool)).toEqual([]);
    expect(await pool.db.select().from(schema.connectorAccount)).toEqual([]);
    expect(state.settings.get('roleTools')).toEqual({
      roles: { user: {}, admin: {}, restricted: { web_search: true } },
    });
    const [audit] = await audits('connector.delete');
    expect(audit?.metadata).toEqual({ name: 'Docs', slug: 'docs', tools: 1, accounts: 1 });
    expect((await call('DELETE', `/api/admin/connectors/${connector.id}`)).status).toBe(404);

    async function connect_(id: string) {
      const started = await ok<{ authorizationUrl: string }>(
        call('POST', `/api/connectors/${id}/connect`, { body: {} }),
      );
      const callback = await mcp.approve(started.authorizationUrl, 'admin-subject');
      await app.request(`${callback.pathname}${callback.search}`, {
        headers: { 'x-test-user': admin },
      });
    }
  });

  it('reports a failing connector on System health', async () => {
    const connector = await createConnector({ url: `${mcp.origin}/redirect` });
    await call('POST', `/api/admin/connectors/${connector.id}/test`);
    await vi.waitFor(async () => {
      const health = await ok<{ checks: Array<{ id: string; status: string; detail: string }> }>(
        call('GET', '/api/admin/health'),
      );
      expect(health.checks.find((check) => check.id === 'connectors')).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('1 of 1 failing. Docs:'),
      });
    });
  });

  describe('failed tests', () => {
    it('records why a failed test failed, so the two failures can be told apart (#368)', async () => {
      const unreachable = await createConnector({
        name: 'Nothing listens',
        url: 'http://127.0.0.1:9/mcp?token=SECRET-QUERY-368',
      });
      const notMcp = await createConnector({
        name: 'A web page',
        url: new URL('/not-an-mcp-endpoint', suite.ctx.mcp.url).toString(),
      });
      const results = [];
      for (const connector of [unreachable, notMcp]) {
        const result = await ok<{ ok: boolean; detail: string }>(
          call('POST', `/api/admin/connectors/${connector.id}/test`),
        );
        expect(result.ok).toBe(false);
        results.push(result.detail);
      }
      const tests = await audits('connector.test');
      const reasons = [unreachable, notMcp].map(
        (connector) =>
          (tests.find((row) => row.targetId === connector.id)?.metadata as { reason?: string })
            ?.reason,
      );
      expect(reasons[0]).toEqual(expect.stringMatching(/\S/));
      expect(reasons[1]).toEqual(expect.stringMatching(/\S/));
      // Same words as the page, and not the same for both.
      expect(reasons).toEqual(results.map((detail) => detail.replace(/\s+/g, ' ').trim()));
      expect(reasons[0]).not.toBe(reasons[1]);
      // The address is recorded without its query.
      const first = tests.find((row) => row.targetId === unreachable.id);
      expect(first?.metadata).toMatchObject({ url: 'http://127.0.0.1:9/mcp', ok: false });
      expect(JSON.stringify(tests)).not.toContain('SECRET-QUERY-368');
    });
  });
});
