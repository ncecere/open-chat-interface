import { schema } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Connector,
  type ConnectorsContext,
  offered,
  SHARED_SECRET,
  textStep,
  toolParts,
  toolStep,
  useConnectorsSuite,
} from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * MCP connector tools end to end: real PostgreSQL, the real admin, connector and
 * chat routes, the real MCP client over Streamable HTTP against an in-process MCP
 * server on 127.0.0.1, and a scripted model that calls connector tools.
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
    settled,
    turn,
    docsConnector,
  } = suite;
  let pool: ConnectorsContext['pool'];
  let alice: ConnectorsContext['alice'];
  let app: ConnectorsContext['app'];
  let mcp: ConnectorsContext['mcp'];
  beforeAll(() => {
    ({ pool, alice, app } = suite.ctx);
  });
  beforeEach(() => {
    mcp = suite.ctx.mcp;
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

    it('shows the contact a test made as soon as it answers (#84)', async () => {
      mcp.tools = [{ name: 'search', annotations: { readOnlyHint: true } }];
      const connector = await createConnector({});
      expect(connector.lastContactAt).toBeNull();
      const result = await ok<{ ok: boolean }>(
        call('POST', `/api/admin/connectors/${connector.id}/test`),
      );
      expect(result.ok).toBe(true);
      // No waiting: the list read straight after the test already has it.
      const { connectors } = await ok<{ connectors: Connector[] }>(
        call('GET', '/api/admin/connectors'),
      );
      expect(connectors.find((entry) => entry.id === connector.id)?.lastContactAt).not.toBeNull();
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
});
