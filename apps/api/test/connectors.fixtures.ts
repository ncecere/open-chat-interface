import { createDatabase, eq, schema, sql } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  seedOrganization,
  seedUser,
} from './live-postgres.js';
import { startTestMcpServer, type TestMcpServer } from './mcp-server.js';

/**
 * Shared setup for the live MCP connector suites (connectors-*.live.test.ts):
 * real PostgreSQL, the real admin, connector and chat routes, the real MCP
 * client over Streamable HTTP against an in-process MCP server on 127.0.0.1,
 * and a scripted model that calls connector tools.
 *
 * Each test file declares its own `vi.mock` block and hoisted `state`, and
 * calls `useConnectorsSuite(state)` inside its top-level `describe`.
 */
export interface ConnectorsState {
  db: unknown;
  organizationId: string;
  model: unknown;
  settings: Map<string, unknown>;
}

export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
export function toolStep(calls: Array<[id: string, tool: string, input: unknown]>) {
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
export function textStep(text: string) {
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
export const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();

export const SHARED_SECRET = 'Bearer SHARED-SECRET-VALUE-7731';

export const toolParts = (parts: Record<string, unknown>[]) =>
  parts.filter((part) => String(part.type).startsWith('tool-') || part.type === 'dynamic-tool');

export type Connector = {
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

export interface ConnectorsContext {
  live: LiveDatabase;
  pool: ReturnType<typeof createDatabase>;
  admin: string;
  auditor: string;
  alice: string;
  bob: string;
  app: Hono<AppBindings>;
  mcp: TestMcpServer;
  invalidate: () => void;
  oauthRedirectUrl: () => string;
}

/**
 * Registers the suite's hooks (a live database per file, a fresh MCP server per
 * test) and returns the helpers the tests use. Call inside the top-level describe.
 */
export function useConnectorsSuite(state: ConnectorsState) {
  const ctx = {} as ConnectorsContext;

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

  beforeAll(async () => {
    ctx.live = await createLiveDatabase('connectors');
    ctx.pool = createDatabase(ctx.live.connectionString, { max: 8 });
    const { pool } = ctx;
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    const auditor = await seedUser(pool.db, state.organizationId, { role: 'auditor' });
    ctx.admin = admin;
    ctx.auditor = auditor;
    ctx.alice = await seedUser(pool.db, state.organizationId);
    ctx.bob = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../src/routes/chat.js');
    const { adminRoutes } = await import('../src/routes/admin/index.js');
    const { connectorRoutes } = await import('../src/routes/connectors.js');
    const { errorHandler } = await import('../src/middleware/error-handler.js');
    ({ invalidateConnectorCatalog: ctx.invalidate } = await import(
      '../src/services/connectors/tools.js'
    ));
    ({ oauthRedirectUrl: ctx.oauthRedirectUrl } = await import(
      '../src/services/connectors/oauth.js'
    ));
    const app = new Hono<AppBindings>();
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
    ctx.app = app;
  });
  beforeEach(async () => {
    state.settings.clear();
    ctx.mcp = await startTestMcpServer();
  });
  afterEach(async () => {
    await ctx.mcp.close();
    await ctx.pool.db.execute(
      sql`update message set status = 'complete' where status = 'streaming'`,
    );
    await ctx.pool.db.delete(schema.connector);
    ctx.invalidate();
  });
  afterAll(async () => {
    await ctx.pool?.sql.end({ timeout: 1 });
    await ctx.live?.destroy();
  });

  function call(
    method: string,
    path: string,
    { user = ctx.admin, body }: { user?: string | null; body?: unknown } = {},
  ) {
    return ctx.app.request(path, {
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
  async function createConnector(body: Record<string, unknown>) {
    return ok<Connector>(
      call('POST', '/api/admin/connectors', {
        body: { name: 'Docs', url: ctx.mcp.url, allowPrivateNetwork: true, ...body },
      }),
      201,
    );
  }
  async function refresh(connector: { id: string }, user = ctx.admin) {
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
    return ctx.pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }
  async function thread(user: string) {
    const [row] = await ctx.pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Connector chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return ctx.pool.db
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
    const response = await ctx.app.request('/api/chat', {
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

  /** A connector with a read tool (search) and a write tool (create_page), refreshed. */
  async function docsConnector(body: Record<string, unknown> = {}) {
    const { mcp } = ctx;
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

  return {
    ctx,
    script,
    call,
    ok,
    createConnector,
    refresh,
    enable,
    getTools,
    allow,
    audits,
    thread,
    rows,
    settled,
    turn,
    docsConnector,
    invalidate: () => ctx.invalidate(),
    oauthRedirectUrl: () => ctx.oauthRedirectUrl(),
  };
}
