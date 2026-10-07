import { createDatabase, eq, schema, sql } from '@oci/db';
import type { MockLanguageModelV4 } from 'ai/test';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { scriptFor, toolsApp, toolsHelpers } from '../../../test/chat-tools.fixtures.js';
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
 * This file: approving and denying write tool calls.
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
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('chat_tools');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
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

  const {
    thread,
    rows,
    settled,
    turn,
    answer,
    toolParts,
    approvalIdOf,
    toolAudits,
    awaitingApproval,
  } = toolsHelpers(
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
});
