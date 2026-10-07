import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  held,
  promptText,
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
 * This file: when automatic compaction triggers and how its summary is used.
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
    rows,
    compactions,
    seedTurns,
    turn,
    jobs,
    background,
    compactionStatus,
    snapshot,
    turnsIn,
    range,
    retry,
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
    it('queues a summary after a reply passes the soft threshold; the next turn uses it with no summary call', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 10);
      const before = await snapshot(chat.id);
      let replyStatusAtSummary: string | undefined;
      const model = script(
        [textStep('Fresh answer')],
        [
          async () => {
            replyStatusAtSummary = (await rows(chat.id)).at(-1)?.status;
            return summary('SUMMARY-ONE', [300, 40]);
          },
        ],
      );
      const { reply } = await turn(chat.id, 'NEW QUESTION');

      // The turn sent everything (it fit) and made no summary call itself:
      // the summary came after the reply had been stored.
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual(range(1, 10));
      expect(systemOf(model.doStreamCalls[0]!.prompt)).not.toContain('<conversation-summary>');
      expect(reply.status).toBe('complete');
      expect(reply.parts.some((part) => part.type === 'data-context-window')).toBe(false);
      await background();
      expect(model.events).toEqual(['reply', 'summary']);
      expect(replyStatusAtSummary).toBe('complete');

      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'automatic', modelSlug: 'test-model', userId: owner });
      expect(record).toMatchObject({ summary: 'SUMMARY-ONE', tokensIn: 300, tokensOut: 40 });
      const keptIndex = seeded.findIndex((row) => row.id === record!.firstKeptMessageId);
      // The cut is at a user message, after at least one turn; the recent
      // turns (up to half the budget) and the newest turn are kept.
      expect(seeded[keptIndex]!.role).toBe('user');
      const firstKeptTurn = keptIndex / 2 + 1;
      expect(firstKeptTurn).toBeGreaterThan(1);
      expect(firstKeptTurn).toBeLessThanOrEqual(10);
      expect(record!.messagesSummarized).toBe(keptIndex);
      expect(record!.tokensSummarized).toBeGreaterThan(0);
      const summaryInput = promptText(model.doGenerateCalls[0]!.prompt);
      expect(turnsIn(summaryInput)).toEqual(range(1, firstKeptTurn - 1));
      expect(summaryInput).toContain('[User]: TURN-1-QUESTION');
      expect(summaryInput).toContain('[Assistant]: TURN-1-ANSWER');
      expect(summaryInput).not.toContain('NEW QUESTION');
      expect(summaryInput).toContain('## Critical details');
      expect(await jobs(chat.id)).toHaveLength(0);

      // The summary call is the person's usage: its own event, no message counted.
      const [event] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, record!.id));
      expect(event).toMatchObject({
        userId: owner,
        modelSlug: 'test-model',
        messageCount: 0,
        tokensIn: 300,
        tokensOut: 40,
        pending: false,
        usageUnknown: false,
      });
      const [run] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, reply.id));
      expect(run).toMatchObject({ messageCount: 1, tokensIn: 20, tokensOut: 7 });

      // Messages are never deleted or changed: every stored row is as it was.
      const after = await rows(chat.id);
      expect(JSON.stringify(after.slice(0, seeded.length))).toBe(before);
      expect(after).toHaveLength(seeded.length + 2);
      expect(await compactionStatus(chat.id)).toEqual({
        compaction: expect.objectContaining({
          id: record!.id,
          firstKeptMessageId: record!.firstKeptMessageId,
          summary: 'SUMMARY-ONE',
          reason: 'automatic',
        }),
        pending: false,
        failure: null,
      });

      // The next turn: the summary in the system prompt, the kept turns
      // verbatim, and no summary call at all.
      const next = script([textStep('Another')]);
      const followUp = await turn(chat.id, 'FOLLOW UP');
      await background();
      expect(next.events).toEqual(['reply']);
      expect(systemOf(next.doStreamCalls[0]!.prompt)).toContain('BASE_SYSTEM_PROMPT');
      expect(systemOf(next.doStreamCalls[0]!.prompt)).toContain('SUMMARY-ONE');
      expect(turnsIn(promptText(next.doStreamCalls[0]!.prompt))).toEqual(range(firstKeptTurn, 10));
      expect(promptText(next.doStreamCalls[0]!.prompt)).toContain('NEW QUESTION');
      expect(followUp.reply.parts.some((part) => part.type === 'data-context-window')).toBe(false);
      expect(await compactions(chat.id)).toHaveLength(1);
    });

    it('queues nothing while the history stays below the soft threshold', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 9);
      const model = script([textStep('Short')], [summary('unused')]);
      await turn(chat.id, 'NEW QUESTION');
      await background();
      expect(model.events).toEqual(['reply']);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect(await compactions(chat.id)).toHaveLength(0);
    });

    it('never makes the person wait: an overlong turn leaves the oldest turns out while the summary is made', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 13);
      const before = await snapshot(chat.id);
      const pending = held('BACKGROUND-SUMMARY');
      const model = script(
        [textStep('One'), textStep('Retried'), textStep('Two'), textStep('Three')],
        [pending.step, summary('SPARE-1'), summary('SPARE-2')],
      );
      // Over budget: this turn falls back to leaving the oldest turns out,
      // marked, and queues a summary, which is now being made (and held).
      const first = await turn(chat.id, 'NEW QUESTION');
      await pending.running;
      expect(first.reply.status).toBe('complete');
      expect(first.reply.parts).toContainEqual(limitedMark);
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).not.toContain(1);
      expect(systemOf(model.doStreamCalls[0]!.prompt)).not.toContain('<conversation-summary>');
      expect((await jobs(chat.id))[0]).toMatchObject({ status: 'running', reason: 'automatic' });
      expect(await compactionStatus(chat.id)).toEqual({
        compaction: null,
        pending: true,
        failure: null,
      });

      // While it runs: retry, switch replies and send, all at once, no 409.
      const prompt = first.stored.at(-2)!;
      const retried = await retry(chat.id, prompt.id, 'NEW QUESTION');
      expect(retried.at(-1)!.parts).toContainEqual(limitedMark);
      const switched = await app.request(
        `/api/threads/${chat.id}/messages/${first.reply.id}/active`,
        { method: 'PATCH' },
      );
      expect(switched.status).toBe(200);
      const second = await turn(chat.id, 'SECOND QUESTION');
      expect(second.reply.status).toBe('complete');
      expect(second.reply.parts).toContainEqual(limitedMark);
      expect(await compactions(chat.id)).toHaveLength(0);

      pending.release();
      await background();
      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'automatic', summary: 'BACKGROUND-SUMMARY' });
      // The newest turn at the time is kept whole, never summarised.
      expect(promptText(model.doGenerateCalls[0]!.prompt)).not.toContain('NEW QUESTION');
      expect(seeded.findIndex((row) => row.id === record!.firstKeptMessageId)).toBeGreaterThan(0);
      expect(JSON.stringify((await rows(chat.id)).slice(0, seeded.length))).toBe(before);

      // The turn after that uses the summary and is no longer limited.
      const third = await turn(chat.id, 'THIRD QUESTION');
      const thirdInput = model.doStreamCalls.at(-1)!.prompt;
      expect(systemOf(thirdInput)).toContain('BACKGROUND-SUMMARY');
      expect(third.reply.parts.some((part) => part.type === 'data-context-window')).toBe(false);
      await background();
      expect(await compactions(chat.id)).toHaveLength(1);
    });

    it('feeds the previous summary into the next compaction, starting at the previous cut', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([textStep('One')], [summary('SUMMARY-ONE')]);
      await turn(chat.id, 'FIRST NEW');
      await background();
      const [first] = await compactions(chat.id);
      const stored = await rows(chat.id);
      const firstKept = stored.findIndex((row) => row.id === first!.firstKeptMessageId);
      const firstKeptTurn = firstKept / 2 + 1;

      await seedTurns(chat.id, 14, 26);
      // A backlog larger than one summariser input is summarised in parts,
      // each carrying the summary so far.
      const parts = ['SUMMARY-TWO-A', 'SUMMARY-TWO-B', 'SUMMARY-TWO-C'];
      const model = script(
        [textStep('Two'), textStep('Three')],
        parts.map((text) => summary(text)),
      );
      const second = await turn(chat.id, 'SECOND NEW');
      // The turn itself used the first summary and left turns out.
      expect(systemOf(model.doStreamCalls[0]!.prompt)).toContain('SUMMARY-ONE');
      expect(second.reply.parts).toContainEqual(limitedMark);
      await background();
      const records = await compactions(chat.id);
      expect(records).toHaveLength(2);
      const calls = model.doGenerateCalls.map((call) => promptText(call.prompt));
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const latest = records[1]!;
      expect(latest.summary).toBe(parts[calls.length - 1]);
      expect(latest.messagesSummarized).toBeGreaterThan(first!.messagesSummarized);
      expect(latest.tokensIn).toBe(300 * calls.length);

      expect(calls[0]).toContain('<previous-summary>\\nSUMMARY-ONE\\n</previous-summary>');
      for (const [index, call] of calls.entries())
        if (index > 0) expect(call).toContain(`<previous-summary>\\n${parts[index - 1]}\\n`);
      const summarisedTurns = calls.flatMap(turnsIn);
      expect(summarisedTurns[0]).toBe(firstKeptTurn);
      expect(summarisedTurns).toEqual(range(firstKeptTurn, summarisedTurns.at(-1)!));
      expect(calls.join('\n')).toContain('FIRST NEW');
      expect(calls.join('\n')).not.toContain(`TURN-${firstKeptTurn - 1}-`);

      await turn(chat.id, 'THIRD NEW');
      const system = systemOf(model.doStreamCalls[1]!.prompt);
      expect(system).toContain(latest.summary);
      expect(system).not.toContain('SUMMARY-ONE');
      expect(turnsIn(promptText(model.doStreamCalls[1]!.prompt))[0]).toBeGreaterThan(
        summarisedTurns.at(-1)!,
      );
    });
  });
});
