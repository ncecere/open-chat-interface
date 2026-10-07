import { createDatabase, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  promptText,
  scriptFor,
  summary,
  textStep,
} from '../../../test/chat-compaction.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Conversation compaction through real PostgreSQL, the real chat and thread
 * routes, turn preparation, the reply stream, persistence, usage accounting
 * and the background queue (in-process kick and job-runner pass), with a
 * scripted model in place of a provider: replies stream (doStream) and
 * summaries are generated (doGenerate). Summaries are only ever made in the
 * background; a reply never waits for one.
 *
 * This file: automatic compaction switched off, unreadable or failing.
 * The shared model script and helpers are in test/chat-compaction.fixtures.ts;
 * the other chat-compaction-*.live.test.ts files cover the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: [] as string[],
  contextWindow: 16_000,
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
    contextWindow: state.contextWindow,
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
  },
  search: { enabled: false, provider: null, baseUrl: null, encryptedApiKey: null, maxResults: 5 },
  chat: { defaultSystemPrompt: null },
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    const value = state.settings.get(key);
    // A setting that cannot be read.
    if (value instanceof Error) throw value;
    return value ?? defaults[key] ?? {};
  },
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => 'BASE_SYSTEM_PROMPT',
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
// A write tool exists only in this test, for the approval continuation.
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
        execute: async () => ({ sent: true }),
      },
    ],
  };
});

const available = await livePostgresAvailable();
const script = scriptFor(state);

describe.skipIf(!available)('live conversation compaction', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('compaction');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    app = await compactionApp(state.organizationId, owner);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = [];
    state.contextWindow = 16_000;
  });
  afterEach(async () => {
    const { compactionQueueSettled } = await import('../../services/chat/compaction-queue.js');
    await compactionQueueSettled();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from quota_policy`);
    await pool.db.execute(sql`delete from conversation_compaction_job`);
    await pool.db.execute(sql`delete from conversation_compaction_failure`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const {
    thread,
    compactions,
    seedTurns,
    turn,
    jobs,
    background,
    processQueue,
    compactionStatus,
    queued,
    compact,
    turnsIn,
    limitedMark,
  } = compactionHelpers({
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
  });

  describe('automatic background compaction', () => {
    it('queues nothing when an administrator switched it off; a manual request still works', async () => {
      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      const model = script([textStep('Answer')], [summary('MANUAL-WHILE-OFF')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      await background();
      expect(model.events).toEqual(['reply']);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect(await compactions(chat.id)).toHaveLength(0);
      expect(reply.parts).toContainEqual(limitedMark);
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).not.toContain(1);

      // An automatic request queued before the switch went off is dropped.
      const other = await thread();
      await seedTurns(other.id, 1, 13);
      await queued(other.id, { reason: 'automatic' });
      expect(await processQueue()).toBe(1);
      expect(await jobs(other.id)).toHaveLength(0);
      expect(model.doGenerateCalls).toHaveLength(0);

      expect((await compact(chat.id)).status).toBe(202);
      await background();
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'manual',
        summary: 'MANUAL-WHILE-OFF',
      });
    });

    it('also summarises a history of many short messages near the message ceiling', async () => {
      const chat = await thread();
      await pool.db.insert(schema.message).values(
        Array.from({ length: 100 }, (_, position) => ({
          threadId: chat.id,
          userId: owner,
          role: position % 2 ? ('assistant' as const) : ('user' as const),
          parts: [{ type: 'text', text: `SHORT-${position}` }],
          position,
          status: 'complete' as const,
        })),
      );
      const model = script([], [summary('MANY-SHORT')]);
      await queued(chat.id, { reason: 'automatic' });
      expect(await processQueue()).toBe(1);
      expect(model.doGenerateCalls).toHaveLength(1);
      expect((await compactions(chat.id))[0]).toMatchObject({ summary: 'MANY-SHORT' });
      // Few, short messages are not worth a summary.
      const few = await thread();
      await seedTurns(few.id, 1, 3);
      await queued(few.id, { reason: 'automatic' });
      expect(await processQueue()).toBe(1);
      expect(model.doGenerateCalls).toHaveLength(1);
    });

    it('treats an unreadable setting as off: nothing is queued or summarised automatically', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      await queued(chat.id, { reason: 'automatic' });
      state.settings.set('chat', new Error('settings unavailable'));
      const model = script([textStep('Answer')], [summary('unused')]);
      expect(await processQueue()).toBe(1);
      expect(await jobs(chat.id)).toHaveLength(0);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      await background();
      expect(reply.parts).toContainEqual(limitedMark);
      expect(model.events).toEqual(['reply']);
      expect(await jobs(chat.id)).toHaveLength(0);
    });

    it('retries a failed summary later, and the reply is never affected', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      const model = script([textStep('Answer')], [new Error('summariser down'), summary('LATER')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      await background();
      expect(reply.status).toBe('complete');
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(await compactions(chat.id)).toHaveLength(0);
      const [job] = await jobs(chat.id);
      expect(job).toMatchObject({ status: 'pending', attempts: 1, claimId: null });
      expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);
      // Not due yet: neither reported as pending nor claimed.
      expect((await compactionStatus(chat.id)).pending).toBe(false);
      expect(await processQueue()).toBe(0);

      await pool.db
        .update(schema.conversationCompactionJob)
        .set({ runAfter: new Date(Date.now() - 1000) });
      expect(await processQueue()).toBe(1);
      expect((await compactions(chat.id))[0]).toMatchObject({ summary: 'LATER' });
      expect(await jobs(chat.id)).toHaveLength(0);
    });

    it('gives up after repeated failures and when the model can no longer be used', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      script([], [new Error('down')]);
      await queued(chat.id, { attempts: 3 });
      expect(await processQueue()).toBe(1);
      expect(await jobs(chat.id)).toHaveLength(0);

      // Too small to summarise with: a refusal is not retried.
      state.contextWindow = 4_000;
      await queued(chat.id);
      expect(await processQueue()).toBe(1);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect(await compactions(chat.id)).toHaveLength(0);
    });
  });
});
