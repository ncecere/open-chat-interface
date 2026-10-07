import { createDatabase, eq, schema, sql } from '@oci/db';
import { validateUIMessages } from 'ai';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  hangingStep,
  offered,
  scriptFor,
  textStep,
  toolStep,
  toolsApp,
  toolsHelpers,
} from '../../../test/chat-tools.fixtures.js';
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
 *
 * This file: the multi-step reply loop.
 * The shared model script and helpers are in test/chat-tools.fixtures.ts; the
 * other chat-tools-*.live.test.ts files cover the rest.
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
  searchFallback: false,
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
    return {
      results: [
        {
          title: 'Library hours',
          url: 'https://library.test/hours',
          snippet: 'SECRET_SNIPPET opens 9am',
        },
        { title: 'City guide', url: 'https://city.test/guide', snippet: 'Hours vary' },
      ],
      provider: state.searchFallback ? 'Brave Search' : 'SearXNG',
      fallback: state.searchFallback,
    };
  },
}));
// A write tool exists only in this test: production has no registration API.
vi.mock('../../services/tools/catalog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/tools/catalog.js')>();
  return {
    registeredTools: async () => [
      ...(await original.registeredTools()),
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
const script = scriptFor(state);

describe.skipIf(!available)('live tool calling', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('chat_tools');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    app = await toolsApp(state.organizationId, owner);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
    state.searches = [];
    state.writes = [];
    state.searchDown = false;
    state.searchFallback = false;
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

  const { thread, settled, send, turn, toolParts, toolAudits } = toolsHelpers(
    {
      get pool() {
        return pool;
      },
      get app() {
        return app;
      },
      get owner() {
        return owner;
      },
      get organizationId() {
        return state.organizationId;
      },
    },
    script,
  );

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
          output: expect.objectContaining({ results: expect.any(Array), provider: 'SearXNG' }),
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

    it('answers without tools after the step limit, with a visible note', async () => {
      state.settings.set('chat', { defaultSystemPrompt: null, maxToolSteps: 2 });
      const chat = await thread();
      const model = script(
        toolStep([['s1', 'web_search', { query: 'one' }]]),
        toolStep([['s2', 'web_search', { query: 'two' }]]),
        textStep('Here is what I found.'),
      );
      const { reply } = await turn(chat.id, 'Search a lot');
      expect(model.doStreamCalls).toHaveLength(3);
      // The last step is for answering: no tools are offered.
      expect(model.doStreamCalls[1]?.tools?.length).toBeGreaterThan(0);
      expect(model.doStreamCalls[2]?.tools ?? []).toHaveLength(0);
      expect(reply.parts).toContainEqual({
        type: 'text',
        text: 'Here is what I found.',
        state: 'done',
      });
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'data-tool-limit', data: { reason: 'steps', steps: 2 } }),
      );
      expect(reply.status).toBe('complete');
    });

    it('tells the model which input was wrong when it sends another tool’s arguments', async () => {
      const chat = await thread();
      // gpt-oss was trained with a browser tool that opens results by id and cursor.
      const model = script(
        toolStep([['s1', 'web_search', { id: 0, cursor: 0 }]]),
        textStep('Searching properly now.'),
      );
      const { reply } = await turn(chat.id, 'Open the first result');
      const [step] = toolParts(reply.parts);
      expect(step).toMatchObject({ state: 'output-error' });
      expect((step as { errorText?: string }).errorText).toMatch(
        /^The input for web_search was not valid: query/,
      );
      // The model is told which field was wrong, too.
      const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
      expect(prompt).toContain('Invalid input for tool web_search');
      expect(prompt).toContain('query');
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
});
