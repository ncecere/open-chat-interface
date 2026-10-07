import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  offered,
  scriptFor,
  textStep,
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
 * This file: which tools a turn offers, and allowing a tool per role.
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

  const { thread, send, turn } = toolsHelpers(
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

    it('records which provider answered the search before the reply', async () => {
      state.capabilities = [];
      state.searchFallback = true;
      const chat = await thread();
      script(textStep('Hello'));
      const { reply } = await turn(chat.id, 'Opening hours?');
      const grounding = reply.parts.find((part) => part.type === 'data-search-grounding') as
        | { data?: { provider?: string; fallback?: boolean } }
        | undefined;
      expect(grounding?.data).toMatchObject({ provider: 'Brave Search', fallback: true });
    });

    it('goes ahead without results when the search before the reply fails, and says why', async () => {
      state.capabilities = [];
      state.searchDown = true;
      const chat = await thread();
      const model = script(textStep('I could not check current sources.'));
      const { reply } = await turn(chat.id, 'What is the NVIDIA share price?');
      const grounding = reply.parts.find((part) => part.type === 'data-search-grounding') as
        | { data?: { results?: unknown[]; error?: string } }
        | undefined;
      expect(grounding?.data).toMatchObject({
        results: [],
        error: 'The web search provider did not respond',
      });
      expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
        'Web search failed: The web search provider did not respond',
      );
      expect(reply.parts.filter((part) => part.type === 'source-url')).toHaveLength(0);
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
