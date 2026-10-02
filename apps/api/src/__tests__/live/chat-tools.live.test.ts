import { createDatabase, eq, schema, sql } from '@oci/db';
import { validateUIMessages } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Tool calling through real PostgreSQL, the real chat routes, turn
 * preparation, reply loop, persistence and usage settlement, with a scripted
 * model in place of a provider.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: ['tool_calling'] as string[],
  settings: new Map<string, unknown>(),
  searches: [] as string[],
  writes: [] as unknown[],
  searchDown: false,
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
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
const defaults: Record<string, unknown> = {
  features: {
    webSearch: true,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  },
  search: {
    enabled: true,
    provider: 'searxng',
    baseUrl: 'http://search.test',
    encryptedApiKey: null,
    maxResults: 5,
  },
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
vi.mock('../../services/lifecycle/settings.js', () => ({
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
}));
vi.mock('../../services/search/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/search/index.js')>()),
  searchWeb: async (query: string) => {
    const features = (state.settings.get('features') ?? defaults.features) as {
      webSearch: boolean;
    };
    if (!features.webSearch) {
      const { validationFailed } = await import('../../lib/errors.js');
      throw validationFailed('Web search is disabled on this instance');
    }
    state.searches.push(query);
    if (state.searchDown) {
      const { providerError } = await import('../../lib/errors.js');
      throw providerError('The web search provider did not respond');
    }
    return [
      {
        title: 'Library hours',
        url: 'https://library.test/hours',
        snippet: 'SECRET_SNIPPET opens 9am',
      },
      { title: 'City guide', url: 'https://city.test/guide', snippet: 'Hours vary' },
    ];
  },
}));
// A write tool exists only in this test: production has no registration API.
vi.mock('../../services/tools/catalog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/tools/catalog.js')>();
  return {
    registeredTools: () => [
      ...original.registeredTools(),
      {
        id: 'send_note',
        label: 'Send note',
        description: 'Sends a note to someone.',
        kind: 'write',
        source: 'builtin',
        inputSchema: z.object({ to: z.string() }),
        available: () => true,
        execute: async (input: unknown) => {
          state.writes.push(input);
          return { sent: true, receipt: 'RECEIPT_CONTENT' };
        },
      },
    ],
  };
});

const available = await livePostgresAvailable();

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
function toolStep(
  calls: Array<[id: string, tool: string, input: unknown]>,
  [input, output]: [number, number] = [10, 5],
) {
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
        usage: usage(input, output),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      },
    ]),
  };
}
function textStep(text: string, [input, output]: [number, number] = [20, 7]) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't' },
      { type: 'text-delta' as const, id: 't', delta: text },
      { type: 'text-end' as const, id: 't' },
      {
        type: 'finish' as const,
        usage: usage(input, output),
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      },
    ]),
  };
}
/** A step that starts and then waits until the run is stopped. */
function hangingStep(started: () => void) {
  return (options: { abortSignal?: AbortSignal }) => {
    started();
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          // As a provider's fetch does when the run is stopped.
          options.abortSignal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      }),
    };
  };
}

function script(...steps: unknown[]) {
  let next = 0;
  const model = new MockLanguageModelV4({
    doStream: (async (options: { abortSignal?: AbortSignal }) => {
      const step = steps[next++];
      if (!step) throw new Error('The scripted model has no more steps');
      return typeof step === 'function' ? step(options) : step;
    }) as never,
  });
  state.model = model;
  return model;
}

/** Tool names offered on one provider call. */
const offered = (model: MockLanguageModelV4, call = 0) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => ('name' in tool ? tool.name : '')).sort();

describe.skipIf(!available)('live tool calling', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('chat_tools');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { rolesRoutes } = await import('../../routes/admin/roles.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: (c.req.header('x-test-role') as 'user') ?? 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
    app.route('/api/admin/roles', rolesRoutes);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
    state.searches = [];
    state.writes = [];
    state.searchDown = false;
    // The test write tool is off by default like any write tool; allow it here.
    state.settings.set('roleTools', { roles: { user: { send_note: true } } });
  });
  afterEach(async () => {
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from quota_policy`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread(user = owner) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Tools chat' })
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
      { timeout: 5_000, interval: 20 },
    );
    return rows(threadId);
  }
  async function send(
    threadId: string,
    text: string,
    options: { webSearch?: boolean; role?: string; user?: string } = {},
  ) {
    return app.request('/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.role ? { 'x-test-role': options.role } : {}),
        ...(options.user ? { 'x-test-user': options.user } : {}),
      },
      body: JSON.stringify({
        threadId,
        modelSlug: 'tool-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: options.webSearch ?? true,
      }),
    });
  }
  /** Sends and waits for the reply to be stored. */
  async function turn(threadId: string, text: string, options: Parameters<typeof send>[2] = {}) {
    const response = await send(threadId, text, options);
    expect(response.status).toBe(200);
    const body = await response.text();
    const stored = await settled(threadId);
    return { body, reply: stored.at(-1)!, stored };
  }
  function answer(
    threadId: string,
    messageId: string,
    responses: Array<{ approvalId: string; approved: boolean }>,
    user = owner,
  ) {
    return app.request(`/api/chat/${threadId}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({ messageId, responses }),
    });
  }
  const toolParts = (parts: Record<string, unknown>[]) =>
    parts.filter((part) => String(part.type).startsWith('tool-') || part.type === 'dynamic-tool');
  const approvalIdOf = (parts: Record<string, unknown>[]) => {
    const pending = toolParts(parts).find((part) => part.state === 'approval-requested');
    return (pending?.approval as { id: string } | undefined)?.id ?? '';
  };
  async function toolAudits() {
    return pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'tool.call'))
      .orderBy(schema.auditLog.createdAt);
  }
  async function awaitingApproval(user = owner) {
    const chat = await thread(user);
    script(toolStep([['w1', 'send_note', { to: 'Ada' }]]), textStep('Done.'), textStep('Unused'));
    const { reply } = await turn(chat.id, 'Send Ada a note', { webSearch: false, user });
    return { chat, reply, approvalId: approvalIdOf(reply.parts) };
  }

  describe('which tools are offered', () => {
    it('offers web_search to a tool-capable model when Search is on, and runs no search first', async () => {
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Opening hours?');
      expect(offered(model)).toEqual(['send_note', 'web_search']);
      expect(state.searches).toEqual([]);
    });

    it('does not offer web_search when the Search switch is off', async () => {
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Opening hours?', { webSearch: false });
      expect(offered(model)).toEqual(['send_note']);
    });

    it('keeps the v0.7 search before the reply for a model without tool calling', async () => {
      state.capabilities = [];
      const chat = await thread();
      const model = script(textStep('Hello'));
      const { reply } = await turn(chat.id, 'Opening hours?');
      expect(model.doStreamCalls[0]?.tools).toBeUndefined();
      expect(state.searches).toEqual(['Opening hours?']);
      expect(reply.parts.some((part) => part.type === 'data-search-grounding')).toBe(true);
      expect(reply.parts.filter((part) => part.type === 'source-url')).toHaveLength(2);
    });

    it('falls back to the search before the reply when the role does not allow the tool', async () => {
      state.settings.set('roleTools', { roles: { user: { web_search: false } } });
      const chat = await thread();
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Opening hours?');
      expect(offered(model)).toEqual([]);
      expect(state.searches).toEqual(['Opening hours?']);
    });

    it('offers no tools to the restricted role by default', async () => {
      state.settings.set('roleTools', {});
      const restricted = await seedUser(pool.db, state.organizationId, { role: 'restricted' });
      const chat = await thread(restricted);
      const model = script(textStep('Hello'));
      await turn(chat.id, 'Opening hours?', { role: 'restricted', user: restricted });
      expect(offered(model)).toEqual([]);
    });

    it('refuses the search like v0.7 when the instance switch is off', async () => {
      state.settings.set('features', { ...(defaults.features as object), webSearch: false });
      const chat = await thread();
      script(textStep('Hello'));
      const response = await send(chat.id, 'Opening hours?');
      expect(response.status).toBe(422);
    });
  });

  describe('the reply loop', () => {
    it('stores a multi-step reply with its tool steps and sources, and replays it as history', async () => {
      const chat = await thread();
      const model = script(
        toolStep([['s1', 'web_search', { query: 'library hours' }]]),
        textStep('The library opens at 9 [source](https://library.test/hours).'),
        textStep('Next answer'),
      );
      const { body, reply } = await turn(chat.id, 'When does the library open?');
      expect(body).toContain('"type":"tool-input-available"');
      expect(state.searches).toEqual(['library hours']);
      expect(reply.status).toBe('complete');
      expect(toolParts(reply.parts)).toEqual([
        expect.objectContaining({
          type: 'tool-web_search',
          state: 'output-available',
          input: { query: 'library hours' },
          output: expect.objectContaining({ results: expect.any(Array) }),
        }),
      ]);
      expect(
        reply.parts.filter((part) => part.type === 'source-url').map((part) => part.url),
      ).toEqual(['https://library.test/hours', 'https://city.test/guide']);
      // Stored parts are valid SDK UI messages, so hydration and replay accept them.
      await expect(
        validateUIMessages({ messages: [{ id: reply.id, role: 'assistant', parts: reply.parts }] }),
      ).resolves.toHaveLength(1);
      // The next turn sees the finished step as a tool call and its result.
      await turn(chat.id, 'And on Sunday?');
      const prompt = JSON.stringify(model.doStreamCalls[2]?.prompt);
      expect(prompt).toContain('"type":"tool-call"');
      expect(prompt).toContain('"type":"tool-result"');
      expect(prompt).toContain('library hours');
    });

    it('turns history tool steps into text when the next turn offers no tools', async () => {
      const chat = await thread();
      const model = script(
        toolStep([['s1', 'web_search', { query: 'library hours' }]]),
        textStep('Nine.'),
        textStep('Plain'),
      );
      await turn(chat.id, 'When does the library open?');
      state.capabilities = [];
      await turn(chat.id, 'Thanks', { webSearch: false });
      const prompt = JSON.stringify(model.doStreamCalls[2]?.prompt);
      expect(prompt).not.toContain('"type":"tool-call"');
      expect(prompt).toContain('Tool step: web_search was called with');
    });

    it('ends the reply at the step limit with a visible note', async () => {
      state.settings.set('chat', { defaultSystemPrompt: null, maxToolSteps: 2 });
      const chat = await thread();
      const model = script(
        toolStep([['s1', 'web_search', { query: 'one' }]]),
        toolStep([['s2', 'web_search', { query: 'two' }]]),
        toolStep([['s3', 'web_search', { query: 'three' }]]),
      );
      const { reply } = await turn(chat.id, 'Search a lot');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'data-tool-limit', data: { reason: 'steps', steps: 2 } }),
      );
      expect(reply.status).toBe('complete');
    });

    it('settles usage across every step of a finished reply', async () => {
      const chat = await thread();
      script(toolStep([['s1', 'web_search', { query: 'q' }]], [10, 5]), textStep('Done', [20, 7]));
      const { reply } = await turn(chat.id, 'Search');
      expect([reply.tokensIn, reply.tokensOut]).toEqual([30, 12]);
      const [event] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, reply.id));
      expect(event).toMatchObject({ tokensIn: 30, tokensOut: 12, pending: false });
    });

    it('counts finished steps when a multi-step reply is stopped mid-step', async () => {
      const chat = await thread();
      let resolveStarted!: () => void;
      const secondStepStarted = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      script(
        toolStep([['s1', 'web_search', { query: 'q' }]], [10, 5]),
        hangingStep(resolveStarted),
      );
      const response = await send(chat.id, 'Search then think');
      const reading = response.text();
      await secondStepStarted;
      const stop = await app.request(`/api/chat/${chat.id}/stream`, { method: 'DELETE' });
      expect(await stop.json()).toEqual({ cancelled: true });
      await reading;
      const stored = await settled(chat.id);
      const reply = stored.at(-1)!;
      expect(reply.status).toBe('cancelled');
      // Before the fix the SDK's total was empty after a stop, so the finished
      // search step's tokens were never recorded.
      expect([reply.tokensIn, reply.tokensOut]).toEqual([10, 5]);
      const [event] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, reply.id));
      // A lower bound: recorded, but still marked unknown with the estimate held.
      expect(event).toMatchObject({
        tokensIn: 10,
        tokensOut: 5,
        pending: false,
        usageUnknown: true,
      });
    });

    it('ends the reply when the allowance runs out between steps', async () => {
      const [policy] = await pool.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId: state.organizationId,
          name: 'Tokens',
          metric: 'tokens',
          limitValue: 100,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
        })
        .returning();
      await pool.db.insert(schema.quotaPolicyRole).values({ policyId: policy!.id, role: 'user' });
      // A fresh person, so earlier tests' usage does not count.
      const person = await seedUser(pool.db, state.organizationId);
      state.settings.set('roleTools', { roles: { user: {} } });
      const chat = await thread(person);
      const model = script(
        toolStep([['s1', 'web_search', { query: 'one' }]], [40, 5]),
        toolStep([['s2', 'web_search', { query: 'two' }]], [60, 5]),
        textStep('Never reached'),
      );
      const { reply } = await turn(chat.id, 'Search twice', { user: person });
      expect(model.doStreamCalls).toHaveLength(2);
      expect(reply.parts).toContainEqual(
        expect.objectContaining({
          type: 'data-tool-limit',
          data: { reason: 'allowance', steps: 8 },
        }),
      );
      expect([reply.tokensIn, reply.tokensOut]).toEqual([100, 10]);
    });

    it('refuses a call to a tool outside the turn’s set without running it', async () => {
      state.settings.set('roleTools', { roles: { user: { send_note: false } } });
      const chat = await thread();
      const model = script(toolStep([['x1', 'send_note', { to: 'Eve' }]]), textStep('Sorry'));
      const { reply } = await turn(chat.id, 'Send a note');
      expect(offered(model)).toEqual(['web_search']);
      expect(state.writes).toEqual([]);
      expect(toolParts(reply.parts)).toEqual([
        expect.objectContaining({
          type: 'dynamic-tool',
          toolName: 'send_note',
          state: 'output-error',
        }),
      ]);
      await vi.waitFor(async () => {
        const audits = (await toolAudits()).filter(
          (row) => (row.metadata as { threadId?: string }).threadId === chat.id,
        );
        expect(audits.map((row) => row.metadata)).toEqual([
          expect.objectContaining({ toolId: 'send_note', outcome: 'refused', kind: null }),
        ]);
      });
    });
  });

  describe('approvals', () => {
    it('saves a write call as awaiting approval without running it', async () => {
      const { reply, approvalId } = await awaitingApproval();
      expect(reply.status).toBe('complete');
      expect(approvalId).toEqual(expect.any(String));
      // The label streams onto the part, so the approval card can name the tool.
      expect(toolParts(reply.parts)[0]).toMatchObject({ title: 'Send note', input: { to: 'Ada' } });
      expect(state.writes).toEqual([]);
    });

    it('continues the same assistant message after an approval', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      const response = await answer(chat.id, reply.id, [{ approvalId, approved: true }]);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-OCI-Chat-Run-Id')).toMatch(new RegExp(`^${reply.id}:`));
      await response.text();
      const stored = await settled(chat.id);
      expect(stored).toHaveLength(2);
      const continued = stored.at(-1)!;
      expect(continued.id).toBe(reply.id);
      expect(continued.status).toBe('complete');
      expect(state.writes).toEqual([{ to: 'Ada' }]);
      expect(toolParts(continued.parts)).toEqual([
        expect.objectContaining({
          state: 'output-available',
          approval: expect.objectContaining({ approved: true }),
        }),
      ]);
      expect(continued.parts.at(-1)).toMatchObject({ type: 'text', text: 'Done.' });
      // Both runs' usage is on the reply; the continuation counts no extra message.
      expect([continued.tokensIn, continued.tokensOut]).toEqual([30, 12]);
      const events = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(sql`split_part(${schema.usageEvent.id}, ':', 1) = ${reply.id}`);
      expect(events.map((event) => event.messageCount).sort()).toEqual([0, 1]);
      const audit = (await toolAudits()).at(-1)!;
      expect(audit.metadata).toMatchObject({
        toolId: 'send_note',
        kind: 'write',
        approvalRequired: true,
        approval: 'approved',
        outcome: 'ok',
      });
    });

    it('sends a denial to the model, which answers without the tool', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      const model = state.model as MockLanguageModelV4;
      const response = await answer(chat.id, reply.id, [{ approvalId, approved: false }]);
      expect(response.status).toBe(200);
      await response.text();
      const continued = (await settled(chat.id)).at(-1)!;
      expect(state.writes).toEqual([]);
      expect(toolParts(continued.parts)).toEqual([
        expect.objectContaining({ state: 'output-denied' }),
      ]);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('execution-denied');
      expect((await toolAudits()).at(-1)?.metadata).toMatchObject({
        outcome: 'denied',
        approval: 'denied',
      });
    });

    it('refuses answers from another person, for another thread or for no open approval', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      expect(
        (await answer(chat.id, reply.id, [{ approvalId, approved: true }], stranger)).status,
      ).toBe(404);
      const other = await thread();
      expect((await answer(other.id, reply.id, [{ approvalId, approved: true }])).status).toBe(404);
      expect(
        (await answer(chat.id, reply.id, [{ approvalId: 'nope', approved: true }])).status,
      ).toBe(422);
      expect(state.writes).toEqual([]);
    });

    it('refuses an answer while a reply is generating', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      await pool.db.insert(schema.message).values({
        threadId: chat.id,
        userId: owner,
        role: 'assistant',
        parts: [],
        position: 99,
        status: 'streaming',
      });
      expect((await answer(chat.id, reply.id, [{ approvalId, approved: true }])).status).toBe(409);
    });

    it('refuses an answer to a reply that is no longer the latest', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      await pool.db.insert(schema.message).values({
        threadId: chat.id,
        userId: owner,
        role: 'user',
        parts: [{ type: 'text', text: 'later' }],
        position: 99,
      });
      expect((await answer(chat.id, reply.id, [{ approvalId, approved: true }])).status).toBe(422);
      expect((await rows(chat.id)).find((row) => row.id === reply.id)?.status).toBe('complete');
    });

    it('refuses an approved call to a tool that is no longer allowed, without running it', async () => {
      const { chat, reply, approvalId } = await awaitingApproval();
      state.settings.set('roleTools', { roles: { user: { send_note: false } } });
      const response = await answer(chat.id, reply.id, [{ approvalId, approved: true }]);
      expect(response.status).toBe(200);
      await response.text();
      const continued = (await settled(chat.id)).at(-1)!;
      expect(state.writes).toEqual([]);
      expect(toolParts(continued.parts)).toEqual([
        expect.objectContaining({
          state: 'output-denied',
          approval: expect.objectContaining({ reason: 'tool no longer available' }),
        }),
      ]);
      await vi.waitFor(async () =>
        expect((await toolAudits()).at(-1)?.metadata).toMatchObject({
          toolId: 'send_note',
          outcome: 'refused',
          approval: 'approved',
        }),
      );
    });

    it('leaves the reply waiting when the allowance is spent before it can continue', async () => {
      const [policy] = await pool.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId: state.organizationId,
          name: 'One message',
          metric: 'tokens',
          limitValue: 10,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
        })
        .returning();
      await pool.db.insert(schema.quotaPolicyRole).values({ policyId: policy!.id, role: 'user' });
      const person = await seedUser(pool.db, state.organizationId);
      const { chat, reply, approvalId } = await awaitingApproval(person);
      const response = await answer(chat.id, reply.id, [{ approvalId, approved: true }], person);
      expect(response.status).toBe(429);
      const [stored] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, reply.id));
      expect(stored?.status).toBe('complete');
      expect(approvalIdOf(stored!.parts)).toBe(approvalId);
      expect(state.writes).toEqual([]);
    });

    it('denies unanswered approvals as "not answered" when a new message is sent', async () => {
      const { chat, reply } = await awaitingApproval();
      const model = state.model as MockLanguageModelV4;
      await turn(chat.id, 'Never mind', { webSearch: false });
      const denied = (await rows(chat.id)).find((row) => row.id === reply.id)!;
      expect(toolParts(denied.parts)).toEqual([
        expect.objectContaining({
          state: 'output-denied',
          approval: expect.objectContaining({ approved: false, reason: 'not answered' }),
        }),
      ]);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('not answered');
      expect(state.writes).toEqual([]);
      expect((await toolAudits()).at(-1)?.metadata).toMatchObject({
        toolId: 'send_note',
        outcome: 'denied',
        approval: 'not answered',
      });
    });
  });

  it('stores a failed search as a failed step and tells the model why', async () => {
    state.searchDown = true;
    const chat = await thread();
    const model = script(toolStep([['s1', 'web_search', { query: 'news' }]]), textStep('Sorry'));
    const { reply } = await turn(chat.id, 'Any news?');
    expect(toolParts(reply.parts)).toEqual([
      expect.objectContaining({
        state: 'output-error',
        errorText: 'The web search provider did not respond',
      }),
    ]);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('did not respond');
    const audit = (await toolAudits()).find(
      (row) => (row.metadata as { threadId?: string }).threadId === chat.id,
    );
    expect(audit?.metadata).toMatchObject({ outcome: 'error', resultBytes: null });
  });

  it('writes tool.call audit events with metadata only', async () => {
    const chat = await thread();
    script(toolStep([['s1', 'web_search', { query: 'PRIVATE_QUERY_TEXT' }]]), textStep('ok'));
    await turn(chat.id, 'Search');
    const [audit] = (await toolAudits()).filter(
      (row) =>
        (row.metadata as { messageId?: string }).messageId !== undefined &&
        (row.metadata as { threadId?: string }).threadId === chat.id,
    );
    expect(Object.keys(audit!.metadata as object).sort()).toEqual([
      'approval',
      'approvalRequired',
      'durationMs',
      'kind',
      'messageId',
      'outcome',
      'resultBytes',
      'threadId',
      'toolId',
    ]);
    expect(audit!.metadata).toMatchObject({
      toolId: 'web_search',
      kind: 'read',
      outcome: 'ok',
      approval: null,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('PRIVATE_QUERY_TEXT');
    expect(serialized).not.toContain('SECRET_SNIPPET');
  });

  it('shows tool steps as summaries in share links and exports, never raw results', async () => {
    const chat = await thread();
    script(toolStep([['s1', 'web_search', { query: 'library hours' }]]), textStep('Nine.'));
    const { reply } = await turn(chat.id, 'When?');
    const { sanitizePublicParts } = await import('../../services/share-links.js');
    const { renderMarkdown, exportableParts } = await import('../../services/export.js');
    const shared = sanitizePublicParts(reply.parts);
    expect(shared).toContainEqual({
      type: 'tool-step',
      toolId: 'web_search',
      summary: "Searched the web for 'library hours' · 2 results",
    });
    expect(JSON.stringify(shared)).not.toContain('SECRET_SNIPPET');
    const markdown = renderMarkdown({ title: 'T', createdAt: new Date() }, [
      {
        role: 'assistant',
        parts: reply.parts,
        modelSlug: 'tool-model',
        status: 'complete',
        createdAt: new Date(),
      },
    ]);
    expect(markdown).toContain("_Searched the web for 'library hours' · 2 results_");
    expect(markdown).not.toContain('SECRET_SNIPPET');
    const archived = JSON.stringify(exportableParts(reply.parts));
    expect(archived).toContain('library hours');
    expect(archived).not.toContain('SECRET_SNIPPET');
  });

  it('lets an administrator allow a tool per role, audited as role.tools.update', async () => {
    const response = await app.request('/api/admin/roles/restricted/tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({ tools: { web_search: true } }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tools: unknown[] }).tools).toContainEqual(
      expect.objectContaining({ id: 'web_search', allowed: true }),
    );
    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'role.tools.update'));
    expect(audit?.metadata).toEqual({
      tools: ['web_search'],
      changes: [{ key: 'web_search', before: false, after: true }],
    });
    const unknown = await app.request('/api/admin/roles/user/tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: { nonexistent: true } }),
    });
    expect(unknown.status).toBe(422);
  });
});
