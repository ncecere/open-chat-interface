import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  held,
  overflow,
  promptText,
  question,
  scriptFor,
  summary,
  systemOf,
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
 * This file: summarising on request, and overflow recovery.
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
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('compaction');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
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
    rows,
    compactions,
    seedTurns,
    turn,
    jobs,
    background,
    compactionStatus,
    snapshot,
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

  describe('summarising on request', () => {
    it('returns 202 at once, completes in the background, and treats a repeat as the same request', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const before = await snapshot(chat.id);
      const pending = held('MANUAL-SUMMARY');
      const model = script([textStep('Meanwhile')], [pending.step, summary('UNUSED')]);
      const response = await compact(chat.id, { instructions: 'keep the budget figures' });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        compaction: null,
        pending: true,
        failure: null,
        summarisable: true,
      });
      await pending.running;
      // A repeat while it runs is the same request.
      const repeat = await compact(chat.id, { instructions: 'something else' });
      expect(repeat.status).toBe(202);
      expect(await repeat.json()).toEqual({
        compaction: null,
        pending: true,
        failure: null,
        summarisable: true,
      });
      expect(await jobs(chat.id)).toHaveLength(1);
      expect(await compactionStatus(chat.id)).toEqual({
        compaction: null,
        pending: true,
        failure: null,
        summarisable: true,
      });
      // The person keeps talking meanwhile.
      const meanwhile = await turn(chat.id, 'MEANWHILE');
      expect(meanwhile.reply.status).toBe('complete');

      pending.release();
      await background();
      expect(model.doGenerateCalls).toHaveLength(1);
      const shown = await compactionStatus(chat.id);
      expect(shown.pending).toBe(false);
      // A request summarises at least half of a short conversation.
      expect(shown.compaction).toMatchObject({
        reason: 'manual',
        firstKeptMessageId: seeded[4]!.id,
      });
      const summaryInput = promptText(model.doGenerateCalls[0]!.prompt);
      expect(summaryInput).toContain('focus on: keep the budget figures');
      expect(turnsIn(summaryInput)).toEqual([1, 2]);
      const [event] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, shown.compaction!.id));
      expect(event).toMatchObject({ messageCount: 0, tokensIn: 300, tokensOut: 40 });
      expect(JSON.stringify((await rows(chat.id)).slice(0, seeded.length))).toBe(before);

      // Later turns use it even with automatic compaction off.
      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const next = script([textStep('Answer')]);
      await turn(chat.id, 'NEXT');
      expect(systemOf(next.doStreamCalls[0]!.prompt)).toContain('MANUAL-SUMMARY');
      expect(turnsIn(promptText(next.doStreamCalls[0]!.prompt))).toEqual([3, 4]);
    });

    it('upgrades a waiting automatic request, with the person’s instructions', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      await queued(chat.id, {
        reason: 'automatic',
        runAfter: new Date(Date.now() + 60 * 60_000),
        attempts: 2,
      });
      const model = script([], [summary('UPGRADED')]);
      expect((await compact(chat.id, { instructions: 'names only' })).status).toBe(202);
      await background();
      expect(promptText(model.doGenerateCalls[0]!.prompt)).toContain('focus on: names only');
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'manual',
        summary: 'UPGRADED',
      });
    });

    it('refuses with nothing to summarise and for someone else, but never because a reply is generating', async () => {
      const chat = await thread();
      script([], [summary('BUSY-SUMMARY')]);
      expect((await compact(chat.id)).status).toBe(422);
      expect((await compactionStatus(chat.id)).summarisable).toBe(false);
      await seedTurns(chat.id, 1, 1);
      // One exchange: the state says so before anyone asks (#153), and the
      // request is refused for the same reason.
      expect((await compactionStatus(chat.id)).summarisable).toBe(false);
      const short = await compact(chat.id);
      expect(short.status).toBe(422);
      expect(await short.text()).toContain('nothing to summarise');
      await seedTurns(chat.id, 2, 2);
      expect((await compactionStatus(chat.id)).summarisable).toBe(true);

      await seedTurns(chat.id, 3, 3);
      expect((await compact(chat.id, {}, stranger)).status).toBe(404);
      expect(
        (
          await app.request(`/api/threads/${chat.id}/compaction`, {
            headers: { 'x-test-user': stranger },
          })
        ).status,
      ).toBe(404);
      // Invalid instructions are refused before anything else.
      expect((await compact(chat.id, { instructions: 'x'.repeat(2001) })).status).toBe(422);
      expect((await compact(chat.id, { other: true })).status).toBe(422);

      // A reply is generating: the request is queued all the same.
      await pool.db.insert(schema.message).values({
        threadId: chat.id,
        userId: owner,
        role: 'assistant',
        parts: [],
        position: 100,
        status: 'streaming',
      });
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      expect((await compactions(chat.id))[0]).toMatchObject({ summary: 'BUSY-SUMMARY' });
    });

    it('names attachments in the transcript and refuses a model too small to summarise with', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const [file] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId: owner,
          messageId: seeded[0]!.id,
          filename: 'budget.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          storageKey: randomUUID(),
          extractedText: 'EXTRACTED_TEXT',
        })
        .returning();
      await pool.db
        .update(schema.message)
        .set({
          parts: [
            { type: 'text', text: question(1) },
            { type: 'data-attachment', data: { id: file!.id, filename: 'budget.pdf' } },
          ],
        })
        .where(eq(schema.message.id, seeded[0]!.id));

      state.contextWindow = 4_000;
      const small = script([], [summary('unused')]);
      const events = async () =>
        (await pool.db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, owner)))
          .length;
      const before = await events();
      const refused = await compact(chat.id);
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain('too small to summarise');
      expect(small.doGenerateCalls).toHaveLength(0);
      expect(await events()).toBe(before);
      expect(await jobs(chat.id)).toHaveLength(0);

      state.contextWindow = 16_000;
      const model = script([], [summary('WITH-FILES')]);
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      const transcript = promptText(model.doGenerateCalls[0]!.prompt);
      expect(transcript).toContain('[User attached]: budget.pdf');
      expect(transcript).not.toContain('EXTRACTED_TEXT');
    });
  });

  describe('overflow recovery', () => {
    it('retries once with the oldest turns left out when the provider says the input is too long', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script([overflow(), textStep('Recovered')], [summary('unused')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      await background();
      expect(model.doStreamCalls).toHaveLength(2);
      // No summary in the reply's path; the short history is not worth one.
      expect(model.events).toEqual(['reply', 'reply']);
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual([1, 2, 3, 4]);
      const retryInput = model.doStreamCalls[1]!.prompt;
      // At most half of the history that was sent, newest turns kept.
      expect(turnsIn(promptText(retryInput))).toEqual([3, 4]);
      expect(promptText(retryInput).match(/NEW QUESTION/g)).toHaveLength(1);
      expect(reply).toMatchObject({ status: 'complete' });
      expect(reply.parts).toContainEqual(limitedMark);
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Recovered' }),
      );
      expect(await compactions(chat.id)).toHaveLength(0);
    });

    it('does not loop: a second overflow fails the reply', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script([overflow(), overflow(), textStep('never')], [summary('S')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(reply.status).toBe('error');
    });

    it('fails as before when there is no history to leave out', async () => {
      const chat = await thread();
      const model = script([overflow()], [summary('unused')]);
      const { reply } = await turn(chat.id, 'FIRST QUESTION');
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(reply.status).toBe('error');
    });

    it('does not retry other provider errors', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script([new Error('provider exploded'), textStep('never')], [summary('S')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(reply.status).toBe('error');
    });
  });
});
