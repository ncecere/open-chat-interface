import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVED_MODEL,
  type ClassificationState,
  UNAPPROVED_MODEL,
  useClassificationSuite,
} from '../../../test/classification.fixtures.js';
import { offered, textStep, toolParts, toolStep } from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Data classification (#395): the places where content reaches a model or
 * leaves OCI, one test each, through the real routes. Every test asserts what
 * the outside party received: zero calls when the decision is to block, one
 * when it allows. Written first against v0.13.1, where every one of them
 * sends, runs, searches or shares regardless of what the conversation holds.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  settings: new Map<string, unknown>(),
  capabilities: ['tool_calling'] as string[],
  searchOrigin: '',
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/models.js')>()),
  resolveModelForRole: async (slug: string) => ({
    slug,
    displayName: slug,
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
vi.mock('../../services/connectors/limits.js', () => ({
  CONNECTOR_LIMITS: {
    timeoutMs: 1_500,
    maxResponseBytes: 64 * 1024,
    maxResultChars: 2_000,
    maxTools: 200,
    maxSchemaChars: 64_000,
  },
}));
const defaults: Record<string, () => unknown> = {
  features: () => ({
    webSearch: true,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  }),
  search: () => ({
    enabled: true,
    provider: 'searxng',
    baseUrl: state.searchOrigin,
    encryptedApiKey: null,
    maxResults: 5,
  }),
  chat: () => ({ defaultSystemPrompt: null }),
  roleFeatures: () => ({
    roles: Object.fromEntries(
      ['admin', 'auditor', 'user', 'restricted'].map((role) => [role, { artifacts: false }]),
    ),
  }),
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key]?.() ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? defaults[key]?.() ?? {}) as object), ...patch };
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
  uploadRateLimit: async () => ({ allowed: true }),
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

describe.skipIf(!available)('live data classification: enforcement points', () => {
  const suite = useClassificationSuite(state as ClassificationState);
  const {
    ctx,
    script,
    call,
    ok,
    createClass,
    approve,
    carry,
    setMode,
    createProject,
    labelProject,
    labelThread,
    projectThread,
    send,
    blocked,
    accepted,
    providerCalls,
    messageCount,
    docsConnector,
    enable,
    allow,
    audits,
    thread,
  } = suite;

  // A SearXNG stand-in that counts the searches it receives.
  let searchServer: Server;
  const search = { hits: 0, queries: [] as string[] };
  beforeAll(async () => {
    searchServer = createServer((request, response) => {
      search.hits += 1;
      search.queries.push(new URL(request.url ?? '/', 'http://stub').searchParams.get('q') ?? '');
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ results: [{ title: 'T', url: 'https://t.test/', content: 'S' }] }));
    });
    await new Promise<void>((resolve) => searchServer.listen(0, '127.0.0.1', resolve));
    state.searchOrigin = `http://127.0.0.1:${(searchServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => searchServer.close(resolve));
  });
  beforeEach(() => {
    search.hits = 0;
    search.queries = [];
  });

  /** A class, a model approved for it, and a conversation in a project labelled with it. */
  async function labelledProjectChat() {
    const student = await createClass('Student records');
    await approve(APPROVED_MODEL, [student.id]);
    const project = await createProject(ctx.alice);
    await labelProject(ctx.alice, project.id, [student.id]);
    return { student, project, chat: await projectThread(ctx.alice, project.id) };
  }

  describe('a. send', () => {
    it('refuses a labelled project conversation for an unapproved model before anything is stored', async () => {
      const { chat } = await labelledProjectChat();
      setMode('block');
      const model = script(textStep('Hello.'));

      const response = await send(ctx.alice, chat.id, 'Marks for J. Smith', {
        modelSlug: UNAPPROVED_MODEL,
      });
      // Nothing was stored, so the web app puts the text back in the box.
      expect(response.headers.get('x-oci-message-saved')).toBe('no');
      const error = await blocked(response);
      expect(error.message).toContain('Student records');
      expect(error.details).toMatchObject({
        point: 'send',
        model: { slug: UNAPPROVED_MODEL },
        missing: [{ name: 'Student records', reasons: ['project'] }],
        approvedModels: [{ slug: APPROVED_MODEL }],
      });
      expect(providerCalls()).toBe(0);
      expect(await messageCount(chat.id)).toBe(0);

      // The same conversation to a model approved for the class goes through once.
      await accepted(
        await send(ctx.alice, chat.id, 'Marks for J. Smith', { modelSlug: APPROVED_MODEL }),
        chat.id,
      );
      expect(model.doStreamCalls).toHaveLength(1);
    });

    it('lets it through in warn mode, once, and says so on the reply', async () => {
      const { chat } = await labelledProjectChat();
      setMode('warn');
      const model = script(textStep('Hello.'));
      const stored = await accepted(
        await send(ctx.alice, chat.id, 'Marks for J. Smith', { modelSlug: UNAPPROVED_MODEL }),
        chat.id,
      );
      expect(model.doStreamCalls).toHaveLength(1);
      expect(stored.at(-1)?.parts).toContainEqual(
        expect.objectContaining({
          type: 'data-classification',
          data: expect.objectContaining({
            mode: 'warn',
            point: 'send',
            missing: ['Student records'],
          }),
        }),
      );
    });
  });

  describe('b. connector tool', () => {
    async function carryingConnector(classIds: string[]) {
      const connector = await docsConnector();
      await enable(connector, 'search');
      await allow(['mcp__docs__search']);
      await carry(connector, classIds);
      return connector;
    }

    it('does not offer a tool whose connector carries a class the model is not approved for', async () => {
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      await carryingConnector([student.id]);
      setMode('block');
      const chat = await thread(ctx.alice);

      let model = script(textStep('No tools for you.'));
      await accepted(await send(ctx.alice, chat.id, 'Find the handbook'), chat.id);
      expect(offered(model)).toEqual([]);
      expect(ctx.mcp.calls).toHaveLength(0);

      const next = await thread(ctx.alice);
      model = script(textStep('Tools are fine.'));
      await accepted(
        await send(ctx.alice, next.id, 'Find the handbook', { modelSlug: APPROVED_MODEL }),
        next.id,
      );
      expect(offered(model)).toEqual(['mcp__docs__search']);
    });

    it('refuses a call at execute when a label arrived mid-turn, and never reaches the server', async () => {
      const student = await createClass('Student records');
      const health = await createClass('Health records');
      await approve(APPROVED_MODEL, [student.id]);
      await carryingConnector([student.id]);
      setMode('block');
      const chat = await thread(ctx.alice);
      script(
        // The person labels the conversation while the model is deciding.
        async () => {
          expect((await labelThread(ctx.alice, chat.id, health.id)).status).toBe(201);
          return toolStep([['c1', 'mcp__docs__search', { query: 'handbook' }]]);
        },
        textStep('Understood.'),
      );

      const stored = await accepted(
        await send(ctx.alice, chat.id, 'Find the handbook', { modelSlug: APPROVED_MODEL }),
        chat.id,
      );
      expect(ctx.mcp.calls).toHaveLength(0);
      const part = toolParts(stored.at(-1)!.parts).find((p) => p.toolCallId === 'c1');
      expect(part).toMatchObject({ state: 'output-error' });
      expect(String(part?.errorText)).toBe('This tool is not available in this conversation.');
      const toolAudits = await audits('tool.call');
      expect(toolAudits.map((row) => (row.metadata as { outcome: string }).outcome)).toEqual([
        'refused',
      ]);
      expect(await suite.auditsOf('classification.block')).toHaveLength(1);
      // Nothing was recorded as used: the call never ran.
      const uses = await ctx.pool.db.select().from(schema.threadConnectorUse);
      expect(uses).toHaveLength(0);
    });

    it('records the use before the call, and then the call reaches the server once', async () => {
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      await carryingConnector([student.id]);
      setMode('block');
      const chat = await thread(ctx.alice);
      script(toolStep([['c1', 'mcp__docs__search', { query: 'handbook' }]]), textStep('Found it.'));
      await accepted(
        await send(ctx.alice, chat.id, 'Find the handbook', { modelSlug: APPROVED_MODEL }),
        chat.id,
      );
      expect(ctx.mcp.calls).toHaveLength(1);
      const uses = await ctx.pool.db.select().from(schema.threadConnectorUse);
      expect(uses.map((row) => row.threadId)).toEqual([chat.id]);
      // The conversation now carries the class, so the unapproved model is refused for it.
      const response = await send(ctx.alice, chat.id, 'And again');
      await blocked(response);
    });
  });

  describe('f and g. web search', () => {
    it('does not offer the search tool, and never searches, for a conversation with a class', async () => {
      const student = await createClass('Student records');
      setMode('block');
      const chat = await thread(ctx.alice);
      expect((await labelThread(ctx.alice, chat.id, student.id)).status).toBe(201);
      // Only the model approved for the class may be used at all.
      await approve(APPROVED_MODEL, [student.id]);
      const model = script(textStep('Answer without searching.'));
      await accepted(
        await send(ctx.alice, chat.id, 'What is on the news?', {
          modelSlug: APPROVED_MODEL,
          webSearch: true,
        }),
        chat.id,
      );
      expect(offered(model)).not.toContain('web_search');
      expect(search.hits).toBe(0);
    });

    it('offers it, and searches once, when the class is approved for web search', async () => {
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      setMode('block', { webSearch: [student.id] });
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, student.id);
      const model = script(
        toolStep([['s1', 'web_search', { query: 'campus news' }]]),
        textStep('Here is the news.'),
      );
      await accepted(
        await send(ctx.alice, chat.id, 'What is on the news?', {
          modelSlug: APPROVED_MODEL,
          webSearch: true,
        }),
        chat.id,
      );
      expect(offered(model)).toContain('web_search');
      expect(search.hits).toBe(1);
    });

    it('skips the up-front search for a model without tool calling and says so', async () => {
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      setMode('block');
      state.capabilities = [];
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, student.id);
      const model = script(textStep('No search was made.'));
      const stored = await accepted(
        await send(ctx.alice, chat.id, 'Marks for J. Smith', {
          modelSlug: APPROVED_MODEL,
          webSearch: true,
        }),
        chat.id,
      );
      // The whole message would have gone to the search provider.
      expect(search.hits).toBe(0);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(stored.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ type: 'data-search-grounding' }),
      );
    });

    it('searches up front once when the conversation carries nothing', async () => {
      setMode('block');
      state.capabilities = [];
      const chat = await thread(ctx.alice);
      script(textStep('Searched.'));
      await accepted(
        await send(ctx.alice, chat.id, 'campus news', {
          modelSlug: APPROVED_MODEL,
          webSearch: true,
        }),
        chat.id,
      );
      expect(search.hits).toBe(1);
    });
  });

  describe('l. share link', () => {
    it('refuses to create a link for a labelled conversation, and creates one for an unlabelled one', async () => {
      const student = await createClass('Student records');
      setMode('block');
      const labelled = await thread(ctx.alice);
      await labelThread(ctx.alice, labelled.id, student.id);

      const refused = await call('POST', `/api/share/threads/${labelled.id}`, {
        user: ctx.alice,
        body: {},
      });
      const error = await blocked(refused);
      expect(error.details).toMatchObject({ point: 'share' });
      const [{ count }] = (await ctx.pool.db.execute(
        sql`select count(*)::int as count from share_link`,
      )) as unknown as [{ count: number }];
      expect(count).toBe(0);

      const plain = await thread(ctx.alice);
      await ok(call('POST', `/api/share/threads/${plain.id}`, { user: ctx.alice, body: {} }), 201);
    });
  });

  it('counts nothing for a conversation in a project without labels, in any mode', async () => {
    setMode('block');
    const project = await createProject(ctx.alice);
    const chat = await projectThread(ctx.alice, project.id);
    const model = script(textStep('Fine.'));
    expect(await messageCount(chat.id)).toBe(0);
    await accepted(await send(ctx.alice, chat.id, 'Hello'), chat.id);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
