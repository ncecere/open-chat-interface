import { eq, schema } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Connector,
  type ConnectorsContext,
  offered,
  textStep,
  toolParts,
  toolStep,
  useConnectorsSuite,
} from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * MCP connector OAuth end to end: real PostgreSQL, the real connector routes and an
 * in-process MCP server with its own OAuth authorization server on 127.0.0.1.
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
  const {
    script,
    call,
    ok,
    createConnector,
    refresh,
    enable,
    getTools,
    allow,
    audits,
    turn,
    invalidate,
    oauthRedirectUrl,
  } = suite;
  let pool: ConnectorsContext['pool'];
  let admin: ConnectorsContext['admin'];
  let alice: ConnectorsContext['alice'];
  let bob: ConnectorsContext['bob'];
  let app: ConnectorsContext['app'];
  let mcp: ConnectorsContext['mcp'];
  beforeAll(() => {
    ({ pool, admin, alice, bob, app } = suite.ctx);
  });
  beforeEach(() => {
    mcp = suite.ctx.mcp;
  });

  describe('OAuth', () => {
    /** Connects a person the way their browser would, returning the callback redirect. */
    async function connect(connectorId: string, user: string, subject: string) {
      const started = await ok<{ authorizationUrl: string }>(
        call('POST', `/api/connectors/${connectorId}/connect`, {
          user,
          body: { returnTo: user === admin ? 'admin' : 'settings' },
        }),
      );
      const callback = await mcp.approve(started.authorizationUrl, subject);
      const response = await app.request(`${callback.pathname}${callback.search}`, {
        headers: { 'x-test-user': user },
      });
      expect(response.status).toBe(302);
      return { location: new URL(response.headers.get('location')!), callback, started };
    }
    async function oauthSetup() {
      mcp.auth = { mode: 'oauth' };
      mcp.tools = [
        { name: 'search', title: 'Search documents', annotations: { readOnlyHint: true } },
      ];
      mcp.handlers.search = (_args, { subject }) => ({
        content: [{ type: 'text', text: `results for ${subject}` }],
      });
      const connector = await createConnector({ authMode: 'oauth' });
      // Tools are listed with the administrator's own connection.
      expect((await call('POST', `/api/admin/connectors/${connector.id}/refresh`)).status).toBe(
        422,
      );
      const adminConnect = await connect(connector.id, admin, 'admin-subject');
      expect(adminConnect.location.pathname).toBe('/admin/connectors');
      expect(adminConnect.location.searchParams.get('connected')).toBe('docs');
      await refresh(connector);
      const tools = await getTools(connector);
      await enable({ ...connector, tools }, 'search');
      return { ...connector, tools };
    }

    it('connects with PKCE and dynamic registration, keeps tokens encrypted, and offers tools only once connected', async () => {
      const connector = await oauthSetup();
      expect(mcp.oauth.registrations).toBe(1);
      const [registered] = await pool.db.select().from(schema.connector);
      expect(registered).toMatchObject({
        oauthClientSource: 'dynamic',
        oauthAuthorizationServer: `${mcp.origin}/`,
      });
      const clientSecret = [...mcp.oauth.clients.values()][0]!.clientSecret!;

      // Not listed or offered until the person's role may use a tool.
      expect(await ok(call('GET', '/api/connectors', { user: alice }))).toEqual({ connectors: [] });
      await allow(['mcp__docs__search']);
      expect(await ok(call('GET', '/api/connectors', { user: alice }))).toEqual({
        connectors: [
          {
            id: connector.id,
            name: 'Docs',
            slug: 'docs',
            connected: false,
            needsReconnect: false,
            toolCount: 1,
          },
        ],
      });
      let model = script(textStep('Connect first'));
      await turn(alice, 'Search');
      expect(offered(model)).toEqual([]);

      const { location } = await connect(connector.id, alice, 'alice');
      expect(location.pathname).toBe('/settings/connectors');
      expect(location.searchParams.get('connected')).toBe('docs');
      expect(
        (
          await ok<{ connectors: Array<{ connected: boolean }> }>(
            call('GET', '/api/connectors', { user: alice }),
          )
        ).connectors[0]?.connected,
      ).toBe(true);

      const accounts = await pool.db.select().from(schema.connectorAccount);
      const serialized =
        JSON.stringify(accounts) + JSON.stringify(await pool.db.select().from(schema.connector));
      for (const secret of [
        ...mcp.oauth.accessTokens.keys(),
        ...mcp.oauth.refreshTokens.keys(),
        clientSecret,
      ])
        expect(serialized).not.toContain(secret);
      const [connected] = await audits('connector.account.connect');
      expect(connected?.metadata).toEqual({ connector: 'docs' });

      model = script(toolStep([['c1', 'mcp__docs__search', {}]]), textStep('Found.'));
      const { reply } = await turn(alice, 'Search');
      expect(offered(model)).toEqual(['mcp__docs__search']);
      expect(toolParts(reply.parts)[0]?.output).toMatchObject({ text: 'results for alice' });

      // Bob has not connected: the tool is not offered to him, and Alice's tokens are never used.
      model = script(textStep('Connect first'));
      await turn(bob, 'Search');
      expect(offered(model)).toEqual([]);
      await connect(connector.id, bob, 'bob');
      script(toolStep([['c1', 'mcp__docs__search', {}]]), textStep('Found.'));
      await turn(bob, 'Search');
      expect(mcp.calls.map((entry) => entry.subject)).toEqual(['alice', 'bob']);
    });

    it('rejects a tampered, expired, reused or another person’s state', async () => {
      const connector = await oauthSetup();
      await allow(['mcp__docs__search']);
      const started = await ok<{ authorizationUrl: string }>(
        call('POST', `/api/connectors/${connector.id}/connect`, { user: alice, body: {} }),
      );
      const callback = await mcp.approve(started.authorizationUrl, 'alice');
      const at = (search: URLSearchParams, user: string | null = alice) =>
        app.request(`/api/connectors/oauth/callback?${search}`, {
          headers: user ? { 'x-test-user': user } : {},
        });
      const errorOf = async (response: Response) => {
        expect(response.status).toBe(302);
        return new URL(response.headers.get('location')!).searchParams.get('error');
      };
      const tampered = new URLSearchParams(callback.search);
      tampered.set('state', `${tampered.get('state')}x`);
      expect(await errorOf(await at(tampered))).toBe('state');
      // Bob cannot complete Alice's attempt (login CSRF), and signed-out requests are refused.
      expect(await errorOf(await at(callback.searchParams, bob))).toBe('state');
      expect(await errorOf(await at(callback.searchParams, null))).toBe('signed-out');
      expect(await errorOf(await at(new URLSearchParams({ code: 'x' })))).toBe('state');
      // Alice's own attempt still works once, then never again.
      const location = new URL((await at(callback.searchParams)).headers.get('location')!);
      expect(location.searchParams.get('connected')).toBe('docs');
      expect(await errorOf(await at(callback.searchParams))).toBe('state');

      // An expired attempt is refused.
      const again = await ok<{ authorizationUrl: string }>(
        call('POST', `/api/connectors/${connector.id}/connect`, { user: alice, body: {} }),
      );
      const late = await mcp.approve(again.authorizationUrl, 'alice');
      await pool.db
        .update(schema.connectorAccount)
        .set({ pendingExpiresAt: new Date(Date.now() - 1_000) });
      expect(await errorOf(await at(late.searchParams))).toBe('state');
      // A cancelled sign-in consumes the attempt.
      const third = await ok<{ authorizationUrl: string }>(
        call('POST', `/api/connectors/${connector.id}/connect`, { user: alice, body: {} }),
      );
      const pending = new URL(third.authorizationUrl).searchParams.get('state')!;
      expect(
        await errorOf(await at(new URLSearchParams({ state: pending, error: 'access_denied' }))),
      ).toBe('denied');
      // People whose role may use none of its tools cannot start connecting.
      state.settings.set('roleTools', { roles: { user: {} } });
      expect(
        (await call('POST', `/api/connectors/${connector.id}/connect`, { user: bob, body: {} }))
          .status,
      ).toBe(404);
    });

    it('refreshes expired tokens, and disconnects when the server refuses the refresh', async () => {
      const connector = await oauthSetup();
      await allow(['mcp__docs__search']);
      await connect(connector.id, alice, 'alice');
      const expire = () =>
        pool.db
          .update(schema.connectorAccount)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(schema.connectorAccount.userId, alice));
      await expire();
      script(toolStep([['c1', 'mcp__docs__search', {}]]), textStep('Found.'));
      const { reply } = await turn(alice, 'Search');
      expect(toolParts(reply.parts)[0]?.state).toBe('output-available');
      expect(mcp.oauth.grantTypes.filter((grant) => grant === 'refresh_token')).toHaveLength(1);
      const [account] = await pool.db
        .select()
        .from(schema.connectorAccount)
        .where(eq(schema.connectorAccount.userId, alice));
      expect(account?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

      await expire();
      mcp.oauth.failRefresh = true;
      script(toolStep([['c1', 'mcp__docs__search', {}]]), textStep('Sorry.'));
      const failed = await turn(alice, 'Search');
      expect(toolParts(failed.reply.parts)[0]).toMatchObject({
        state: 'output-error',
        errorText: expect.stringContaining('Connect Docs again in Settings'),
      });
      expect(await ok(call('GET', '/api/connectors', { user: alice }))).toEqual({
        connectors: [expect.objectContaining({ connected: false, needsReconnect: true })],
      });
      const model = script(textStep('Reconnect'));
      await turn(alice, 'Search');
      expect(offered(model)).toEqual([]);
    });

    it('refreshes once across replicas with rotating refresh tokens, and every caller gets the new token', async () => {
      const connector = await oauthSetup();
      await allow(['mcp__docs__search']);
      await connect(connector.id, alice, 'alice');
      // Two "replicas": separate module instances, so separate in-process
      // single-flight maps, sharing only the database.
      const replicaA = await import('../../services/connectors/oauth.js');
      vi.resetModules();
      const replicaB = await import('../../services/connectors/oauth.js');
      expect(replicaB.connectionAuthFor).not.toBe(replicaA.connectionAuthFor);

      const [row] = await pool.db
        .select()
        .from(schema.connector)
        .where(eq(schema.connector.id, connector.id));
      const aliceAccount = () =>
        pool.db
          .select()
          .from(schema.connectorAccount)
          .where(eq(schema.connectorAccount.userId, alice))
          .then((rows) => rows[0]);
      const expire = () =>
        pool.db
          .update(schema.connectorAccount)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(schema.connectorAccount.userId, alice));
      const refreshes = () => mcp.oauth.grantTypes.filter((grant) => grant === 'refresh_token');
      const accessTokenOf = async (auth: { authProvider?: { tokens(): unknown } }) =>
        ((await auth.authProvider?.tokens()) as { access_token?: string } | undefined)
          ?.access_token;

      await expire();
      const issuedBefore = new Set(mcp.oauth.accessTokens.keys());
      // Slow refresh: both replicas read the expired tokens before either finishes.
      mcp.oauth.refreshDelayMs = 300;
      const [first, second] = await Promise.all([
        replicaA.connectionAuthFor(row!, alice),
        replicaB.connectionAuthFor(row!, alice),
      ]);
      expect(refreshes()).toHaveLength(1);
      const fresh = await accessTokenOf(first);
      expect(fresh).toBeTruthy();
      expect(issuedBefore.has(fresh!)).toBe(false);
      expect(mcp.oauth.accessTokens.has(fresh!)).toBe(true);
      expect(await accessTokenOf(second)).toBe(fresh);
      expect(await aliceAccount()).toMatchObject({ disconnectedReason: null });
      expect((await aliceAccount())?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

      // A caller still holding the replaced tokens (as after a 401 mid-call) is
      // refused by the rotating server; it adopts the stored replacement and
      // refreshes with that rather than disconnecting the person.
      mcp.oauth.refreshDelayMs = 0;
      await expire();
      const replaced = await replicaB.connectionAuthFor(row!, alice);
      expect(refreshes()).toHaveLength(2);
      const { auth } = await import('@ai-sdk/mcp');
      const stale = first.authProvider!;
      await expect(auth(stale, { serverUrl: row!.url })).resolves.toBe('AUTHORIZED');
      expect(mcp.oauth.grantTypes.slice(-2)).toEqual(['refresh_token', 'refresh_token']);
      const latest = await accessTokenOf(first);
      expect(latest).not.toBe(fresh);
      expect(latest).not.toBe(await accessTokenOf(replaced));
      expect(mcp.oauth.accessTokens.has(latest!)).toBe(true);
      const account = await aliceAccount();
      expect(account?.encryptedTokens).toBeTruthy();
      expect(account?.disconnectedReason).toBeNull();
    });

    it('disconnects, revoking the token, and audits it', async () => {
      const connector = await oauthSetup();
      await allow(['mcp__docs__search']);
      await connect(connector.id, alice, 'alice');
      const refreshTokens = [...mcp.oauth.refreshTokens.keys()];
      const response = await ok<{ ok: boolean; revoked: boolean }>(
        call('DELETE', `/api/connectors/${connector.id}/account`, { user: alice }),
      );
      expect(response).toEqual({ ok: true, revoked: true });
      expect(refreshTokens).toContain(mcp.oauth.revoked[0]);
      expect(
        await pool.db
          .select()
          .from(schema.connectorAccount)
          .where(eq(schema.connectorAccount.userId, alice)),
      ).toEqual([]);
      const [audit] = await audits('connector.account.disconnect');
      expect(audit?.metadata).toEqual({ connector: 'docs', revoked: true });
      expect(
        (await call('DELETE', `/api/connectors/${connector.id}/account`, { user: alice })).status,
      ).toBe(404);
    });

    it('uses an administrator’s client when the server has no registration, and pins the sign-in server', async () => {
      mcp.oauth.supportsRegistration = false;
      mcp.auth = { mode: 'oauth' };
      const noClient = await createConnector({ authMode: 'oauth' });
      const refused = await call('POST', `/api/connectors/${noClient.id}/connect`, {
        user: admin,
        body: {},
      });
      expect(refused.status).toBe(502);
      expect(await refused.text()).toContain('enter a client ID');

      mcp.addClient({
        clientId: 'manual-client',
        clientSecret: 'MANUAL-CLIENT-SECRET-99',
        redirectUris: [oauthRedirectUrl()],
      });
      const updated = await ok<Connector>(
        call('PATCH', `/api/admin/connectors/${noClient.id}`, {
          body: { oauthClientId: 'manual-client', oauthClientSecret: 'MANUAL-CLIENT-SECRET-99' },
        }),
      );
      expect(updated).toMatchObject({
        oauthClientId: 'manual-client',
        hasOauthClientSecret: true,
        oauthClientSource: 'manual',
      });
      expect(JSON.stringify(updated)).not.toContain('MANUAL-CLIENT-SECRET-99');
      const { location } = await connect(noClient.id, admin, 'admin-subject');
      expect(location.searchParams.get('connected')).toBe('docs');
      const [stored] = await pool.db.select().from(schema.connector);
      expect(JSON.stringify(stored)).not.toContain('MANUAL-CLIENT-SECRET-99');

      // Changing the server's address ends everyone's connection and the pin.
      await ok(
        call('PATCH', `/api/admin/connectors/${noClient.id}`, { body: { url: `${mcp.url}?v=2` } }),
      );
      expect(await pool.db.select().from(schema.connectorAccount)).toEqual([]);
      const [reset] = await pool.db.select().from(schema.connector);
      expect(reset?.oauthAuthorizationServer).toBeNull();
      expect((await audits('connector.update')).at(-1)?.metadata).toMatchObject({
        accountsRemoved: 1,
      });

      // A sign-in server other than the pinned one is refused.
      await pool.db
        .update(schema.connector)
        .set({ oauthAuthorizationServer: 'https://other.example.test/' });
      invalidate();
      const pinned = await call('POST', `/api/connectors/${noClient.id}/connect`, {
        user: admin,
        body: {},
      });
      expect(pinned.status).toBe(502);
      expect(await pinned.text()).toContain('different sign-in server');
    });
  });
});
