import { createDatabase, eq, schema, sql } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { startTestMcpServer, type TestMcpServer } from '../../../test/mcp-server.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * MCP connectors end to end: real PostgreSQL, the real admin, connector and
 * chat routes, the real MCP client over Streamable HTTP against an in-process
 * MCP server (with its own OAuth authorization server) on 127.0.0.1, and a
 * scripted model that calls connector tools.
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

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
function toolStep(calls: Array<[id: string, tool: string, input: unknown]>) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      ...calls.map(([toolCallId, toolName, value]) => ({
        type: 'tool-call' as const,
        toolCallId,
        toolName,
        input: JSON.stringify(value),
      })),
      {
        type: 'finish' as const,
        usage: usage(10, 5),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      },
    ]),
  };
}
function textStep(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't' },
      { type: 'text-delta' as const, id: 't', delta: text },
      { type: 'text-end' as const, id: 't' },
      {
        type: 'finish' as const,
        usage: usage(20, 7),
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      },
    ]),
  };
}
function script(...steps: unknown[]) {
  let next = 0;
  const model = new MockLanguageModelV4({
    doStream: (async () => {
      const step = steps[next++];
      if (!step) throw new Error('The scripted model has no more steps');
      return step;
    }) as never,
  });
  state.model = model;
  return model;
}
const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();

const SHARED_SECRET = 'Bearer SHARED-SECRET-VALUE-7731';

describe.skipIf(!available)('live MCP connectors', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let auditor: string;
  let alice: string;
  let bob: string;
  let app: Hono<AppBindings>;
  let mcp: TestMcpServer;
  let invalidate: () => void;
  let oauthRedirectUrl: () => string;

  beforeAll(async () => {
    live = await createLiveDatabase('connectors');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    auditor = await seedUser(pool.db, state.organizationId, { role: 'auditor' });
    alice = await seedUser(pool.db, state.organizationId);
    bob = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { adminRoutes } = await import('../../routes/admin/index.js');
    const { connectorRoutes } = await import('../../routes/connectors.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    ({ invalidateConnectorCatalog: invalidate } = await import(
      '../../services/connectors/tools.js'
    ));
    ({ oauthRedirectUrl } = await import('../../services/connectors/oauth.js'));
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      const id = c.req.header('x-test-user');
      if (!id) {
        c.set('user', null);
      } else {
        const role = id === admin ? 'admin' : id === auditor ? 'auditor' : 'user';
        c.set('user', {
          id,
          name: 'Test',
          email: `${role}@example.test`,
          image: null,
          role,
          emailVerified: true,
          organizationId: state.organizationId,
        });
      }
      await next();
    });
    app.route('/api/chat', chatRoutes);
    app.route('/api/admin', adminRoutes);
    app.route('/api/connectors', connectorRoutes);
  });
  beforeEach(async () => {
    state.settings.clear();
    mcp = await startTestMcpServer();
  });
  afterEach(async () => {
    await mcp.close();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.delete(schema.connector);
    invalidate();
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function call(
    method: string,
    path: string,
    { user = admin, body }: { user?: string | null; body?: unknown } = {},
  ) {
    return app.request(path, {
      method,
      headers: {
        ...(user ? { 'x-test-user': user } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
    const resolved = await response;
    const text = await resolved.text();
    expect(resolved.status, text).toBe(status);
    return JSON.parse(text) as T;
  }
  type Connector = {
    id: string;
    slug: string;
    tools: Array<{
      id: string;
      toolId: string;
      name: string;
      kind: string;
      serverKind: string;
      enabled: boolean;
      missing: boolean;
    }>;
  } & Record<string, unknown>;
  async function createConnector(body: Record<string, unknown>) {
    return ok<Connector>(
      call('POST', '/api/admin/connectors', {
        body: { name: 'Docs', url: mcp.url, allowPrivateNetwork: true, ...body },
      }),
      201,
    );
  }
  async function refresh(connector: { id: string }, user = admin) {
    return ok<{ added: number; updated: number; missing: number; tools: Connector['tools'] }>(
      call('POST', `/api/admin/connectors/${connector.id}/refresh`, { user }),
    );
  }
  async function enable(connector: Connector, name: string, extra: Record<string, unknown> = {}) {
    const tool =
      connector.tools.find((entry) => entry.name === name) ??
      (await getTools(connector)).find((entry) => entry.name === name);
    return ok<Connector['tools'][number]>(
      call('PATCH', `/api/admin/connectors/${connector.id}/tools/${tool!.id}`, {
        body: { enabled: true, ...extra },
      }),
    );
  }
  async function getTools(connector: { id: string }) {
    return (await ok<Connector>(call('GET', `/api/admin/connectors/${connector.id}`))).tools;
  }
  async function allow(toolIds: string[], role = 'user') {
    await ok(
      call('PUT', `/api/admin/roles/${role}/tools`, {
        body: { tools: Object.fromEntries(toolIds.map((id) => [id, true])) },
      }),
    );
  }
  async function audits(action: string) {
    return pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }
  async function thread(user: string) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Connector chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function settled(threadId: string) {
    await vi.waitFor(
      async () => {
        const stored = await rows(threadId);
        expect(stored.some((row) => row.status === 'streaming')).toBe(false);
      },
      { timeout: 8_000, interval: 25 },
    );
    return rows(threadId);
  }
  async function turn(user: string, text: string, threadId?: string) {
    const chat = threadId ?? (await thread(user)).id;
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({
        threadId: chat,
        modelSlug: 'tool-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: false,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await response.text();
    const stored = await settled(chat);
    return { chatId: chat, reply: stored.at(-1)! };
  }
  const toolParts = (parts: Record<string, unknown>[]) =>
    parts.filter((part) => String(part.type).startsWith('tool-') || part.type === 'dynamic-tool');

  /** A connector with a read tool (search) and a write tool (create_page), refreshed. */
  async function docsConnector(body: Record<string, unknown> = {}) {
    mcp.tools = [
      {
        name: 'search',
        title: 'Search documents',
        description: 'Finds documents.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'create_page',
        description: 'Creates a page.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      },
    ];
    mcp.handlers.search = (args) => ({
      content: [
        { type: 'text', text: `Found 1 document for ${String(args.query)}. RESULT_BODY_TEXT` },
        {
          type: 'resource_link',
          uri: 'https://docs.example.test/handbook',
          name: 'handbook',
          title: 'Staff handbook',
        },
        { type: 'resource_link', uri: 'file:///etc/passwd', name: 'not a web link' },
      ],
    });
    mcp.handlers.create_page = (args) => ({
      content: [{ type: 'text', text: `Created ${String(args.title)}` }],
    });
    const connector = await createConnector(body);
    await refresh(connector);
    return { ...connector, tools: await getTools(connector) };
  }

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

  describe('tools', () => {
    it('lists tools with kinds from readOnlyHint, disabled, and marks vanished tools missing', async () => {
      mcp.pageSize = 1;
      mcp.tools = [
        { name: 'search', annotations: { readOnlyHint: true } },
        { name: 'delete_all', annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: 'files.read' },
      ];
      const connector = await createConnector({});
      const first = await refresh(connector);
      expect(first).toMatchObject({ added: 3, updated: 0, missing: 0 });
      expect(
        first.tools.map(({ name, toolId, kind, serverKind, enabled, missing }) => ({
          name,
          toolId,
          kind,
          serverKind,
          enabled,
          missing,
        })),
      ).toEqual([
        {
          name: 'delete_all',
          toolId: 'mcp__docs__delete_all',
          kind: 'write',
          serverKind: 'write',
          enabled: false,
          missing: false,
        },
        // Dots are not allowed in provider function names.
        {
          name: 'files.read',
          toolId: 'mcp__docs__files_read',
          kind: 'write',
          serverKind: 'write',
          enabled: false,
          missing: false,
        },
        {
          name: 'search',
          toolId: 'mcp__docs__search',
          kind: 'read',
          serverKind: 'read',
          enabled: false,
          missing: false,
        },
      ]);

      mcp.tools = [{ name: 'search', annotations: { readOnlyHint: true } }];
      const second = await refresh(connector);
      expect(second).toMatchObject({ added: 0, updated: 1, missing: 2 });
      expect(second.tools.filter((tool) => tool.missing).map((tool) => tool.name)).toEqual([
        'delete_all',
        'files.read',
      ]);
      const [audit] = (await audits('connector.tools.refresh')).slice(-1);
      expect(audit?.metadata).toEqual({ slug: 'docs', added: 0, updated: 1, missing: 2 });
    });

    it('lets a read tool be marked write freely, but a write tool read only with confirmation', async () => {
      const connector = await docsConnector();
      const search = connector.tools.find((tool) => tool.name === 'search')!;
      const create = connector.tools.find((tool) => tool.name === 'create_page')!;
      const path = (tool: { id: string }) =>
        `/api/admin/connectors/${connector.id}/tools/${tool.id}`;
      expect(await ok(call('PATCH', path(search), { body: { kind: 'write' } }))).toMatchObject({
        kind: 'write',
      });
      expect((await call('PATCH', path(create), { body: { kind: 'read' } })).status).toBe(422);
      expect(
        await ok(call('PATCH', path(create), { body: { kind: 'read', confirmReadOnly: true } })),
      ).toMatchObject({ kind: 'read', serverKind: 'write' });
      const updates = await audits('connector.tool.update');
      expect(updates.at(-1)?.metadata).toEqual({
        slug: 'docs',
        toolId: 'mcp__docs__create_page',
        changes: { kind: { before: 'write', after: 'read' } },
        readOnlyConfirmed: true,
      });
      // A refresh keeps the administrator's confirmed choice.
      await refresh(connector);
      expect((await getTools(connector)).find((tool) => tool.name === 'create_page')?.kind).toBe(
        'read',
      );
      expect((await call('PATCH', path({ id: 'nope' }), { body: { enabled: true } })).status).toBe(
        404,
      );
    });

    it('lists connector tools in Roles & access, off for every role until allowed', async () => {
      const connector = await docsConnector();
      await enable(connector, 'search');
      const roles = await ok<{
        roles: Array<{ role: string; tools: Array<Record<string, unknown>> }>;
      }>(call('GET', '/api/admin/roles'));
      for (const role of roles.roles)
        expect(role.tools).toContainEqual({
          id: 'mcp__docs__search',
          label: 'Search documents',
          kind: 'read',
          source: 'connector',
          allowed: false,
          connector: 'Docs',
        });
      // A disabled tool is not offered anywhere, so it cannot be allowed.
      expect(
        (
          await call('PUT', '/api/admin/roles/user/tools', {
            body: { tools: { mcp__docs__create_page: true } },
          })
        ).status,
      ).toBe(422);
    });
  });

  describe('in a conversation', () => {
    it('offers a connector tool only when enabled and allowed, and cites its links', async () => {
      const connector = await docsConnector({
        authMode: 'shared',
        sharedHeaderValue: SHARED_SECRET,
      });
      mcp.auth = { mode: 'header', header: { name: 'Authorization', value: SHARED_SECRET } };

      let model = script(textStep('No tools yet'));
      await turn(alice, 'Find the handbook');
      expect(offered(model)).toEqual([]);

      await enable(connector, 'search');
      model = script(textStep('Not allowed yet'));
      await turn(alice, 'Find the handbook');
      expect(offered(model)).toEqual([]);

      await allow(['mcp__docs__search']);
      model = script(
        toolStep([['c1', 'mcp__docs__search', { query: 'handbook' }]]),
        textStep('See the handbook.'),
      );
      const { reply } = await turn(alice, 'Find the handbook');
      expect(offered(model)).toEqual(['mcp__docs__search']);
      expect(mcp.calls).toEqual([
        { name: 'search', arguments: { query: 'handbook' }, subject: null, header: SHARED_SECRET },
      ]);
      expect(toolParts(reply.parts)).toEqual([
        expect.objectContaining({
          type: 'tool-mcp__docs__search',
          title: 'Search documents',
          state: 'output-available',
          output: {
            sources: [{ url: 'https://docs.example.test/handbook', title: 'Staff handbook' }],
            text: expect.stringContaining('RESULT_BODY_TEXT'),
          },
        }),
      ]);
      expect(reply.parts.filter((part) => part.type === 'source-url')).toEqual([
        expect.objectContaining({
          url: 'https://docs.example.test/handbook',
          title: 'Staff handbook',
        }),
      ]);
      // The server's initialize instructions never reach the model.
      expect(JSON.stringify(model.doStreamCalls)).not.toContain('IGNORE ALL PREVIOUS');
      const [audit] = (await audits('tool.call')).slice(-1);
      expect(audit?.metadata).toMatchObject({
        toolId: 'mcp__docs__search',
        kind: 'read',
        outcome: 'ok',
        approvalRequired: false,
      });
      expect(JSON.stringify(audit)).not.toContain('RESULT_BODY_TEXT');
      expect(JSON.stringify(audit)).not.toContain('handbook');
      await vi.waitFor(async () => {
        const [contacted] = await pool.db.select().from(schema.connector);
        expect(contacted?.lastContactAt).toBeInstanceOf(Date);
      });
    });

    it('asks before running a write tool, runs it on approval and not on denial', async () => {
      const connector = await docsConnector();
      await enable(connector, 'create_page');
      await allow(['mcp__docs__create_page']);
      const ask = async () => {
        script(toolStep([['w1', 'mcp__docs__create_page', { title: 'Plan' }]]), textStep('Done.'));
        const { chatId, reply } = await turn(alice, 'Create a page');
        const pending = toolParts(reply.parts).find((part) => part.state === 'approval-requested');
        expect(pending).toMatchObject({ input: { title: 'Plan' } });
        return { chatId, reply, approvalId: (pending!.approval as { id: string }).id };
      };
      const answer = (chatId: string, messageId: string, approvalId: string, approved: boolean) =>
        app.request(`/api/chat/${chatId}/approvals`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-user': alice },
          body: JSON.stringify({ messageId, responses: [{ approvalId, approved }] }),
        });

      const denied = await ask();
      expect(mcp.calls).toEqual([]);
      const no = await answer(denied.chatId, denied.reply.id, denied.approvalId, false);
      expect(no.status).toBe(200);
      await no.text();
      await settled(denied.chatId);
      expect(mcp.calls).toEqual([]);

      const approved = await ask();
      const yes = await answer(approved.chatId, approved.reply.id, approved.approvalId, true);
      expect(yes.status).toBe(200);
      await yes.text();
      const [continued] = (await settled(approved.chatId)).slice(-1);
      expect(mcp.calls).toEqual([
        { name: 'create_page', arguments: { title: 'Plan' }, subject: null, header: null },
      ]);
      expect(toolParts(continued!.parts)).toEqual([
        expect.objectContaining({
          state: 'output-available',
          output: { sources: [], text: 'Created Plan' },
        }),
      ]);
      // Denials are recorded without waiting, so compare as a set rather than by order.
      await vi.waitFor(async () =>
        expect(
          (await audits('tool.call')).map((row) => {
            const { toolId, kind, approval, outcome } = row.metadata as Record<string, unknown>;
            return { toolId, kind, approval, outcome };
          }),
        ).toEqual(
          expect.arrayContaining([
            {
              toolId: 'mcp__docs__create_page',
              kind: 'write',
              approval: 'denied',
              outcome: 'denied',
            },
            {
              toolId: 'mcp__docs__create_page',
              kind: 'write',
              approval: 'approved',
              outcome: 'ok',
            },
          ]),
        ),
      );
    });

    it('fails a step that times out, returns too much, or reports an error, and tells the model', async () => {
      const connector = await docsConnector();
      await enable(connector, 'search');
      await allow(['mcp__docs__search']);
      const failure = async (handler: (typeof mcp.handlers)[string]) => {
        mcp.handlers.search = handler;
        const model = script(
          toolStep([['c1', 'mcp__docs__search', { query: 'q' }]]),
          textStep('Sorry.'),
        );
        const { reply } = await turn(alice, 'Search');
        const [part] = toolParts(reply.parts);
        expect(part?.state).toBe('output-error');
        expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(String(part?.errorText));
        return String(part?.errorText);
      };
      expect(await failure(() => mcp.hang())).toBe('Docs did not respond in time.');
      expect(
        await failure(() => ({ content: [{ type: 'text', text: 'x'.repeat(100 * 1024) }] })),
      ).toBe('Docs could not be used. The server’s response was too large.');
      expect(
        await failure(() => ({
          content: [{ type: 'text', text: 'Quota exceeded' }],
          isError: true,
        })),
      ).toBe('Docs reported an error: Quota exceeded');
      // A tool's own error is not a connector failure; the oversize response was.
      await vi.waitFor(async () => {
        const [failing] = await pool.db.select().from(schema.connector);
        expect(failing?.lastError).toBe(
          'Docs could not be used. The server’s response was too large.',
        );
      });

      // Large but within the response limit: kept, cut to the result limit.
      mcp.handlers.search = () => ({ content: [{ type: 'text', text: 'y'.repeat(10_000) }] });
      script(toolStep([['c1', 'mcp__docs__search', { query: 'q' }]]), textStep('Ok.'));
      const { reply } = await turn(alice, 'Search');
      expect(toolParts(reply.parts)[0]?.output).toEqual({
        sources: [],
        text: 'y'.repeat(2_000),
        truncated: true,
      });
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
});
