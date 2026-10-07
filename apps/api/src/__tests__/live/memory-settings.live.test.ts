import { createDatabase, schema, sql } from '@oci/db';
import { MAX_MEMORY_CHARS, MAX_MEMORY_ENTRIES } from '@oci/shared';
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
 * This suite covers the Settings API, retention, legal hold and the audit trail; the shared fixtures live in
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

  const { audits, call, memories, optIn, seedMemory, thread, turn } = memoryHelpers(state, () => ({
    pool,
    owner,
    app,
  }));

  beforeAll(async () => {
    live = await createLiveDatabase('user_memory_settings');
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

  describe('Settings API', () => {
    it('lists, adds, edits and deletes only the person’s own memories', async () => {
      await seedMemory('Stranger fact', { user: stranger });
      const added = await call('POST', '', { content: '  Uses   Linux ' });
      expect(added.status).toBe(201);
      const { memory } = (await added.json()) as { memory: { id: string; content: string } };
      expect(memory).toMatchObject({ content: 'Uses Linux', source: 'person' });

      const listed = (await (await call('GET', '')).json()) as {
        enabled: boolean;
        available: boolean;
        entries: Array<{ content: string }>;
        limits: unknown;
      };
      expect(listed).toMatchObject({
        enabled: true,
        available: true,
        limits: { maxEntries: MAX_MEMORY_ENTRIES, maxChars: MAX_MEMORY_CHARS },
      });
      expect(listed.entries.map((entry) => entry.content)).toEqual(['Uses Linux']);

      const edited = await call('PATCH', `/${memory.id}`, { content: 'Uses Fedora Linux' });
      expect(edited.status).toBe(200);
      expect((await memories())[0]?.content).toBe('Uses Fedora Linux');

      // Another person's memory does not exist for them.
      expect((await call('PATCH', `/${memory.id}`, { content: 'x' }, stranger)).status).toBe(404);
      expect((await call('DELETE', `/${memory.id}`, undefined, stranger)).status).toBe(404);
      expect((await memories()).length).toBe(1);

      expect((await call('DELETE', `/${memory.id}`)).status).toBe(200);
      expect(await memories()).toEqual([]);
      expect((await call('DELETE', `/${memory.id}`)).status).toBe(404);
      expect(await memories(stranger)).toHaveLength(1);
    });

    it('deletes everything at once, leaving other people’s alone', async () => {
      await seedMemory('One');
      await seedMemory('Two');
      await seedMemory('Stranger fact', { user: stranger });
      const response = await call('DELETE', '');
      expect(await response.json()).toEqual({ deleted: 2 });
      expect(await memories()).toEqual([]);
      expect(await memories(stranger)).toHaveLength(1);
    });

    it('validates length, refuses duplicates and enforces the entry limit', async () => {
      const long = await call('POST', '', { content: 'a'.repeat(MAX_MEMORY_CHARS + 1) });
      expect(long.status).toBe(422);
      expect((await call('POST', '', { content: '   ' })).status).toBe(422);
      expect((await call('POST', '', { content: 'Same' })).status).toBe(201);
      const duplicate = await call('POST', '', { content: 'same' });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ created: false });

      await pool.db.insert(schema.userMemory).values(
        Array.from({ length: MAX_MEMORY_ENTRIES - 1 }, (_, index) => ({
          userId: owner,
          content: `Fact ${index}`,
          source: 'person' as const,
        })),
      );
      const full = await call('POST', '', { content: 'Too many' });
      expect(full.status).toBe(422);
      expect(await memories()).toHaveLength(MAX_MEMORY_ENTRIES);
    });

    it('keeps reading and deleting available when memory is switched off, but not adding', async () => {
      const note = await seedMemory('Kept after switch-off');
      state.settings.set('features', { ...(defaults.features as object), memory: false });
      const listed = (await (await call('GET', '')).json()) as {
        available: boolean;
        entries: unknown[];
      };
      expect(listed.available).toBe(false);
      expect(listed.entries).toHaveLength(1);
      expect((await call('POST', '', { content: 'New' })).status).toBe(403);
      expect((await call('PATCH', `/${note.id}`, { content: 'Edited' })).status).toBe(403);
      // Switching on is refused; switching off always works.
      expect((await call('PUT', '/settings', { enabled: true })).status).toBe(403);
      expect((await call('PUT', '/settings', { enabled: false })).status).toBe(200);
      expect((await call('DELETE', `/${note.id}`)).status).toBe(200);
    });

    it('lets a person opt in and out', async () => {
      await optIn(owner, false);
      const on = await call('PUT', '/settings', { enabled: true });
      expect(await on.json()).toMatchObject({ enabled: true, available: true });
      const off = await call('PUT', '/settings', { enabled: false });
      expect(await off.json()).toMatchObject({ enabled: false });
    });
  });

  describe('retention', () => {
    it('deletes memories not updated within the retention period, and does nothing when off', async () => {
      const { applyMemoryRetention } = await import('../../services/memory/store.js');
      const now = new Date('2026-06-01T00:00:00Z');
      await seedMemory('Old note', { updatedAt: new Date('2026-01-01T00:00:00Z') });
      await seedMemory('Recent note', { updatedAt: new Date('2026-05-25T00:00:00Z') });
      await seedMemory('Stranger old', {
        user: stranger,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });

      expect(await applyMemoryRetention(now)).toBe(0);
      expect((await memories()).length + (await memories(stranger)).length).toBe(3);

      state.settings.set('retention', { memoryRetentionDays: 30 });
      expect(await applyMemoryRetention(now)).toBe(2);
      expect((await memories()).map((row) => row.content)).toEqual(['Recent note']);
      expect(await memories(stranger)).toEqual([]);
      // One deletion event per note (v0.10), with no actor and never the text.
      const events = (await audits()).filter((row) => row.action === 'memory.delete');
      expect(events).toHaveLength(2);
      for (const event of events)
        expect(event).toMatchObject({
          actorUserId: null,
          targetType: 'user',
          metadata: {
            count: 1,
            via: 'retention',
            retentionDays: 30,
            deletion: { type: 'memory', reason: 'retention', permanent: true },
          },
        });
      expect(new Set(events.map((event) => event.targetId)).size).toBe(2);
      expect(JSON.stringify(events)).not.toContain('Old note');
    });
  });

  describe('retention and legal hold', () => {
    it('keeps the memories of a person on legal hold', async () => {
      const { applyMemoryRetention } = await import('../../services/memory/store.js');
      const now = new Date('2026-06-01T00:00:00Z');
      await pool.db.delete(schema.userMemory);
      await seedMemory('Old note', { updatedAt: new Date('2026-01-01T00:00:00Z') });
      await seedMemory('Held old note', {
        user: stranger,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      await pool.db.insert(schema.legalHold).values({
        organizationId: state.organizationId,
        userId: stranger,
        userEmail: 'held@example.test',
        reason: 'Records request',
      });
      state.settings.set('retention', { memoryRetentionDays: 30 });
      try {
        expect(await applyMemoryRetention(now)).toBe(1);
        expect(await memories()).toEqual([]);
        expect((await memories(stranger)).map((row) => row.content)).toEqual(['Held old note']);
      } finally {
        await pool.db.delete(schema.legalHold);
      }
    });
  });

  describe('audit', () => {
    it('records adds, edits and deletes as metadata only, never the text', async () => {
      const chat = await thread();
      script(toolStep([['r1', 'remember', { content: 'SECRET_TOOL_NOTE' }]]), textStep('Ok'));
      await turn(chat.id, 'Remember');
      const added = await call('POST', '', { content: 'SECRET_PERSON_NOTE' });
      const { memory } = (await added.json()) as { memory: { id: string } };
      await call('PATCH', `/${memory.id}`, { content: 'SECRET_EDITED_NOTE' });
      await call('DELETE', `/${memory.id}`);
      await call('DELETE', '');

      const events = await audits();
      expect(events.map((row) => row.action)).toEqual([
        'memory.add',
        'memory.add',
        'memory.update',
        'memory.delete',
        'memory.delete',
      ]);
      expect(events[0]?.metadata).toMatchObject({ count: 1, source: 'tool', via: 'tool' });
      expect(events[0]?.metadata).toMatchObject({ threadId: chat.id });
      expect(events[1]?.metadata).toMatchObject({ count: 1, source: 'person', via: 'settings' });
      expect(events[4]?.metadata).toMatchObject({ count: 1, via: 'settings' });
      const serialized = JSON.stringify(events);
      for (const secret of ['SECRET_TOOL_NOTE', 'SECRET_PERSON_NOTE', 'SECRET_EDITED_NOTE'])
        expect(serialized).not.toContain(secret);
    });
  });
});
