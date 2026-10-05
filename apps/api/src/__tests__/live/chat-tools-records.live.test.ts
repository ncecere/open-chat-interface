import { createDatabase, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
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
 * This file: failed steps, tool.call audit events, share links and exports.
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

  const { thread, turn, toolParts, toolAudits } = toolsHelpers(
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
});
