import { createDatabase, schema, sql } from '@oci/db';
import { MAX_MEMORY_ENTRIES } from '@oci/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  buildMemoryApp,
  createScript,
  memoryHelpers,
  systemOf,
  textStep,
  toolStep,
} from '../../../test/memory.fixtures.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * User memory (v0.9) through real PostgreSQL, the real chat and memory
 * routes, turn preparation and the tool loop, with a scripted model in place
 * of a provider: which switches allow it, what reaches the system prompt,
 * the remember and forget tools, undo, the Settings API, limits, retention
 * and the audit trail.
 * This suite covers the remember and forget tools and undo; the shared fixtures live in
 * test/memory.fixtures.ts.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: ['tool_calling'] as string[],
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
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    // Input budget: 64,000 - 1,000 - 512 = 62,488 units; memory gets 5% (3,124).
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
const defaults: Record<string, unknown> = {
  features: {
    webSearch: false,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
    memory: true,
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
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => 'BASE PROMPT',
}));
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

const available = await livePostgresAvailable();

const script = createScript(state);

describe.skipIf(!available)('live user memory', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;

  const { call, memories, optIn, seedMemory, thread, toolParts, turn } = memoryHelpers(
    state,
    () => ({ pool, owner, app }),
  );

  beforeAll(async () => {
    live = await createLiveDatabase('user_memory_tools');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    app = await buildMemoryApp(state, () => owner);
  });
  beforeEach(async () => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
    await pool.db.execute(sql`delete from user_memory`);
    await pool.db.execute(sql`delete from audit_log`);
    await optIn(owner, true);
    await optIn(stranger, true);
  });
  afterEach(async () => {
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  describe('the remember and forget tools', () => {
    it('saves a memory from a scripted turn without approval and shows it in the reply', async () => {
      const chat = await thread();
      const model = script(
        toolStep([['r1', 'remember', { content: '  Prefers   short answers ' }]]),
        textStep('Noted.'),
      );
      const { reply } = await turn(chat.id, 'Remember that I like short answers');
      expect(model.doStreamCalls).toHaveLength(2);
      const saved = await memories();
      expect(saved).toEqual([
        expect.objectContaining({
          content: 'Prefers short answers',
          source: 'tool',
          threadId: chat.id,
          messageId: reply.id,
        }),
      ]);
      expect(toolParts(reply.parts)).toEqual([
        expect.objectContaining({
          type: 'tool-remember',
          state: 'output-available',
          output: { action: 'added', id: saved[0]!.id, content: 'Prefers short answers' },
        }),
      ]);
      expect(reply.status).toBe('complete');
      // The same note again changes nothing and offers nothing to undo.
      script(toolStep([['r2', 'remember', { content: 'prefers short answers' }]]), textStep('Ok'));
      const again = await turn(chat.id, 'Remember it again');
      expect(toolParts(again.reply.parts)[0]).toMatchObject({
        output: { action: 'exists', id: saved[0]!.id },
      });
      expect(await memories()).toHaveLength(1);
    });

    it('forgets a memory by the id shown in the prompt', async () => {
      const old = await seedMemory('Lives in Paris', { updatedAt: new Date(Date.now() - 60_000) });
      await seedMemory('Likes tea');
      const chat = await thread();
      const ref = old.id.slice(0, 8);
      const model = script(toolStep([['f1', 'forget', { id: ref }]]), textStep('Forgotten.'));
      const { reply } = await turn(chat.id, 'I moved, forget where I live');
      expect(systemOf(model)).toContain(`[${ref}] Lives in Paris`);
      expect((await memories()).map((row) => row.content)).toEqual(['Likes tea']);
      expect(toolParts(reply.parts)[0]).toMatchObject({
        type: 'tool-forget',
        state: 'output-available',
        output: { action: 'removed', id: old.id, content: 'Lives in Paris' },
      });
    });

    it('reports an unknown id to the model as a failed step', async () => {
      const chat = await thread();
      const model = script(toolStep([['f1', 'forget', { id: 'deadbeef' }]]), textStep('Sorry.'));
      const { reply } = await turn(chat.id, 'Forget it');
      expect(toolParts(reply.parts)[0]).toMatchObject({ state: 'output-error' });
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
        'There is no memory with that id.',
      );
    });

    it('cannot forget someone else’s memory', async () => {
      const theirs = await seedMemory('Stranger fact', { user: stranger });
      const chat = await thread();
      script(toolStep([['f1', 'forget', { id: theirs.id.slice(0, 8) }]]), textStep('Hm.'));
      const { reply } = await turn(chat.id, 'Forget it');
      expect(toolParts(reply.parts)[0]).toMatchObject({ state: 'output-error' });
      expect(await memories(stranger)).toHaveLength(1);
    });

    it('refuses to save past the limit and tells the model why', async () => {
      await pool.db.insert(schema.userMemory).values(
        Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) => ({
          userId: owner,
          content: `Fact ${index}`,
          source: 'person' as const,
        })),
      );
      const chat = await thread();
      const model = script(toolStep([['r1', 'remember', { content: 'One more' }]]), textStep('Ok'));
      const { reply } = await turn(chat.id, 'Remember one more');
      expect(toolParts(reply.parts)[0]).toMatchObject({ state: 'output-error' });
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
        `limit of ${MAX_MEMORY_ENTRIES} memories`,
      );
      expect(await memories()).toHaveLength(MAX_MEMORY_ENTRIES);
    });
  });

  describe('undo', () => {
    it('deletes a remembered note, and repeating it changes nothing', async () => {
      const chat = await thread();
      script(toolStep([['r1', 'remember', { content: 'Has a dog' }]]), textStep('Noted.'));
      const { reply } = await turn(chat.id, 'Remember my dog');
      const first = await call('POST', '/undo', { messageId: reply.id, toolCallId: 'r1' });
      expect(await first.json()).toEqual({ action: 'removed', changed: true });
      expect(await memories()).toEqual([]);
      const second = await call('POST', '/undo', { messageId: reply.id, toolCallId: 'r1' });
      expect(await second.json()).toEqual({ action: 'removed', changed: false });
    });

    it('restores a forgotten note under its old id', async () => {
      const note = await seedMemory('Speaks Welsh');
      const chat = await thread();
      script(toolStep([['f1', 'forget', { id: note.id.slice(0, 8) }]]), textStep('Done.'));
      const { reply } = await turn(chat.id, 'Forget the Welsh');
      expect(await memories()).toEqual([]);
      const response = await call('POST', '/undo', { messageId: reply.id, toolCallId: 'f1' });
      expect(await response.json()).toEqual({ action: 'restored', changed: true });
      expect(await memories()).toEqual([
        expect.objectContaining({ id: note.id, content: 'Speaks Welsh', threadId: chat.id }),
      ]);
    });

    it('is refused for someone else’s reply and for a step that changed no memory', async () => {
      const chat = await thread();
      script(toolStep([['r1', 'remember', { content: 'Owner fact' }]]), textStep('Noted.'));
      const { reply, stored } = await turn(chat.id, 'Remember');
      const foreign = await call(
        'POST',
        '/undo',
        { messageId: reply.id, toolCallId: 'r1' },
        stranger,
      );
      expect(foreign.status).toBe(404);
      const wrongStep = await call('POST', '/undo', { messageId: reply.id, toolCallId: 'zz' });
      expect(wrongStep.status).toBe(422);
      const prompt = await call('POST', '/undo', { messageId: stored[0]!.id, toolCallId: 'r1' });
      expect(prompt.status).toBe(404);
      expect(await memories()).toHaveLength(1);
    });
  });
});
