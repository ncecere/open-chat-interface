import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { strFromU8, unzipSync } from 'fflate';
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
 * Conversation compaction through real PostgreSQL, the real chat and thread
 * routes, turn preparation, the reply stream, persistence, usage accounting
 * and the background queue (in-process kick and job-runner pass), with a
 * scripted model in place of a provider: replies stream (doStream) and
 * summaries are generated (doGenerate). Summaries are only ever made in the
 * background; a reply never waits for one.
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

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
function textStep(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't' },
      { type: 'text-delta' as const, id: 't', delta: text },
      { type: 'text-end' as const, id: 't' },
      {
        type: 'finish' as const,
        usage: usage(20, 7),
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      },
    ]),
  };
}
function toolStep(id: string, tool: string, input: unknown) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: id, toolName: tool, input: JSON.stringify(input) },
      {
        type: 'finish' as const,
        usage: usage(10, 5),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      },
    ]),
  };
}
/** What a provider says when the input is longer than its model accepts. */
function overflow() {
  return new APICallError({
    message:
      "This model's maximum context length is 16000 tokens. Please reduce the length of the messages.",
    url: 'https://provider.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"code":"context_length_exceeded"}}',
    isRetryable: false,
  });
}
function summary(text: string, [input, output]: [number, number] = [300, 40]) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: usage(input, output),
    warnings: [],
  };
}

/**
 * Replies and summaries, each in order. A thrown value is thrown by the call.
 * `events` records the order of reply and summary calls.
 */
function script(replies: unknown[], summaries: unknown[] = []) {
  let reply = 0;
  let summarised = 0;
  const events: Array<'reply' | 'summary'> = [];
  const next = (steps: unknown[], index: number) => {
    const step = steps[index];
    if (!step) throw new Error('The scripted model has no more steps');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step() : step;
  };
  const model = Object.assign(
    new MockLanguageModelV4({
      doStream: (async () => {
        events.push('reply');
        return next(replies, reply++);
      }) as never,
      doGenerate: (async () => {
        events.push('summary');
        return next(summaries, summarised++);
      }) as never,
    }),
    { events },
  );
  state.model = model;
  return model;
}
/** A summary that is only returned once `release` is called. */
function held(text: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    step: async () => {
      started();
      await gate;
      return summary(text);
    },
    running,
    release,
  };
}
const promptText = (prompt: unknown) => JSON.stringify(prompt);
const systemOf = (prompt: unknown) =>
  (prompt as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');

/** One long turn of about 1,100 input units, with markers to find it by. */
const question = (turn: number) => `TURN-${turn}-QUESTION ${'q'.repeat(480)}`;
const answer = (turn: number) => `TURN-${turn}-ANSWER ${'a'.repeat(480)}`;

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
    const { chatRoutes } = await import('../../routes/chat.js');
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
    app.route('/api/threads', threadRoutes);
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
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread(user = owner) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: state.organizationId, title: 'Long chat' })
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
  async function compactions(threadId: string) {
    return pool.db
      .select()
      .from(schema.conversationCompaction)
      .where(eq(schema.conversationCompaction.threadId, threadId))
      .orderBy(schema.conversationCompaction.createdAt);
  }
  /** Stores turns `from`..`to` after whatever the thread already has. */
  async function seedTurns(threadId: string, from: number, to: number, user = owner) {
    const existing = await rows(threadId);
    let position = (existing.at(-1)?.position ?? -1) + 1;
    const values = [];
    for (let turn = from; turn <= to; turn++) {
      for (const [role, text] of [
        ['user', question(turn)],
        ['assistant', answer(turn)],
      ] as const) {
        values.push({
          id: randomUUID(),
          threadId,
          userId: user,
          role,
          parts: [{ type: 'text', text }],
          position,
          modelSlug: role === 'assistant' ? 'test-model' : null,
          status: 'complete' as const,
          createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, position)),
        });
        position++;
      }
    }
    await pool.db.insert(schema.message).values(values);
    return values;
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
  async function turn(threadId: string, text: string, user = owner) {
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: false,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const stored = await settled(threadId);
    return { body, reply: stored.at(-1)!, stored };
  }
  async function jobs(threadId: string) {
    return pool.db
      .select()
      .from(schema.conversationCompactionJob)
      .where(eq(schema.conversationCompactionJob.threadId, threadId));
  }
  /** Waits for this process's background compaction pass to finish. */
  async function background() {
    const { compactionQueueSettled } = await import('../../services/chat/compaction-queue.js');
    await compactionQueueSettled();
  }
  async function processQueue() {
    const { processCompactionQueue } = await import('../../services/chat/compaction-queue.js');
    return processCompactionQueue();
  }
  async function compactionStatus(threadId: string, user = owner) {
    const response = await app.request(`/api/threads/${threadId}/compaction`, {
      headers: { 'x-test-user': user },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      compaction: { id: string; reason: string; firstKeptMessageId: string } | null;
      pending: boolean;
    };
  }
  /** Every stored message, field by field, to prove compaction changes none. */
  async function snapshot(threadId: string) {
    return JSON.stringify(await rows(threadId));
  }
  /** Queues a request directly, as a stopped replica would have left it. */
  async function queued(
    threadId: string,
    values: Partial<typeof schema.conversationCompactionJob.$inferInsert> = {},
    user = owner,
  ) {
    await pool.db.insert(schema.conversationCompactionJob).values({
      threadId,
      userId: user,
      reason: 'manual',
      modelSlug: 'test-model',
      ...values,
    });
  }
  function compact(threadId: string, body: Record<string, unknown> = {}, user = owner) {
    return app.request(`/api/threads/${threadId}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(body),
    });
  }
  /** Turn numbers whose markers appear in a prompt. */
  const turnsIn = (text: string) =>
    [
      ...new Set([...text.matchAll(/TURN-(\d+)-(?:QUESTION|ANSWER)/g)].map((m) => Number(m[1]))),
    ].sort((a, b) => a - b);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  async function retry(threadId: string, promptId: string, text: string) {
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        trigger: 'regenerate-message',
        messages: [{ id: promptId, role: 'user', parts: [{ type: 'text', text }] }],
        webSearch: false,
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    return settled(threadId);
  }
  const limitedMark = expect.objectContaining({
    type: 'data-context-window',
    data: { limited: true },
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
      expect(await compactionStatus(chat.id)).toEqual({ compaction: null, pending: true });

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

  describe('the queue', () => {
    it('is picked up by the job runner after a restart, including a claim whose lease ran out', async () => {
      const { lifecycleJobs, COMPACTION_JOB } = await import('../../services/jobs/index.js');
      const job = lifecycleJobs().find((candidate) => candidate.name === COMPACTION_JOB)!;
      expect(job.intervalMs).toBeLessThanOrEqual(60_000);

      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const other = await thread();
      await seedTurns(other.id, 1, 4);
      const model = script([], [summary('AFTER-RESTART'), summary('TAKEN-OVER')]);
      await queued(chat.id);
      // A replica stopped while summarising: its lease ran out.
      await queued(other.id, {
        status: 'running',
        claimId: 'stopped-replica',
        leaseUntil: new Date(Date.now() - 1000),
        attempts: 1,
      });
      expect(await job.run()).toBe(2);
      expect(model.doGenerateCalls).toHaveLength(2);
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'manual',
        firstKeptMessageId: seeded[4]!.id,
      });
      expect(await compactions(other.id)).toHaveLength(1);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect(await jobs(other.id)).toHaveLength(0);
    });

    it('lets one worker at a time summarise a conversation', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script(
        [],
        [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return summary('ONCE');
          },
          summary('TWICE'),
        ],
      );
      await queued(chat.id);
      // Two workers (two replicas' passes) at once: one claims, one finds nothing.
      const handled = await Promise.all([processQueue(), processQueue()]);
      expect(handled.sort()).toEqual([0, 1]);
      expect(model.doGenerateCalls).toHaveLength(1);
      expect((await compactions(chat.id)).map((record) => record.summary)).toEqual(['ONCE']);

      // A claim whose lease is still running is not taken over.
      await queued(chat.id, {
        status: 'running',
        claimId: 'live-replica',
        leaseUntil: new Date(Date.now() + 60_000),
      });
      expect(await processQueue()).toBe(0);
      expect(await compactionStatus(chat.id)).toMatchObject({ pending: true });
    });

    it('skips while the person’s allowance is spent and tries again later', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const chat = await thread(person);
      await seedTurns(chat.id, 1, 13, person);
      const [policy] = await pool.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId: state.organizationId,
          name: 'Tiny',
          metric: 'tokens',
          limitValue: 1,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
        })
        .returning();
      await pool.db.insert(schema.quotaPolicyRole).values({ policyId: policy!.id, role: 'user' });
      await pool.db.insert(schema.usageEvent).values({
        organizationId: state.organizationId,
        userId: person,
        modelSlug: 'test-model',
        tokensIn: 10,
        tokensOut: 10,
      });
      const model = script([], [summary('WHEN-ALLOWED')]);
      const { requestCompaction } = await import('../../services/chat/compaction-queue.js');
      await requestCompaction({
        threadId: chat.id,
        userId: person,
        modelSlug: 'test-model',
        reason: 'automatic',
      });
      await background();
      expect(model.doGenerateCalls).toHaveLength(0);
      const [job] = await jobs(chat.id);
      expect(job).toMatchObject({ status: 'pending', attempts: 0 });
      expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      // Background checks are not refusals the person made.
      expect(
        await pool.db
          .select()
          .from(schema.quotaDenial)
          .where(eq(schema.quotaDenial.userId, person)),
      ).toHaveLength(0);
      // A manual request is refused at once.
      expect((await compact(chat.id, {}, person)).status).toBe(429);

      await pool.db.execute(sql`delete from quota_policy`);
      await pool.db
        .update(schema.conversationCompactionJob)
        .set({ runAfter: new Date(Date.now() - 1000) });
      expect(await processQueue()).toBe(1);
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'automatic',
        summary: 'WHEN-ALLOWED',
        userId: person,
      });
    });

    it('drops queued work when the conversation is trashed, and discards a summary being made', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      await queued(chat.id, { runAfter: new Date(Date.now() + 60_000) });
      const trash = (threadId: string) =>
        app.request(`/api/threads/${threadId}`, { method: 'DELETE' });
      expect((await trash(chat.id)).status).toBe(200);
      expect(await jobs(chat.id)).toHaveLength(0);

      const other = await thread();
      await seedTurns(other.id, 1, 4);
      const pending = held('TOO-LATE');
      const model = script([], [pending.step]);
      expect((await compact(other.id)).status).toBe(202);
      await pending.running;
      expect((await trash(other.id)).status).toBe(200);
      expect(await jobs(other.id)).toHaveLength(0);
      pending.release();
      await background();
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(await compactions(other.id)).toHaveLength(0);

      // A request that was claimed just before the conversation was trashed.
      const third = await thread();
      await seedTurns(third.id, 1, 4);
      await queued(third.id);
      await pool.db
        .update(schema.thread)
        .set({ deletedAt: new Date() })
        .where(eq(schema.thread.id, third.id));
      expect(await processQueue()).toBe(1);
      expect(await jobs(third.id)).toHaveLength(0);
      expect(model.doGenerateCalls).toHaveLength(1);
    });

    it('keeps the newest cut and discards a summary whose messages changed meanwhile', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const racing = (firstKeptMessageId: string) =>
        pool.db.insert(schema.conversationCompaction).values({
          threadId: chat.id,
          userId: owner,
          firstKeptMessageId,
          summary: 'RACING',
          reason: 'manual',
          messagesSummarized: 6,
          tokensSummarized: 10,
          modelSlug: 'test-model',
        });
      // A further cut lands first: this one (at turn 3) is discarded.
      script(
        [],
        [
          async () => {
            await racing(seeded[6]!.id);
            return summary('SHORTER-CUT');
          },
        ],
      );
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      expect((await compactions(chat.id)).map((record) => record.summary)).toEqual(['RACING']);

      // A message it summarised is gone: discarded.
      const other = await thread();
      const otherSeeded = await seedTurns(other.id, 1, 4);
      script(
        [],
        [
          async () => {
            await pool.db.delete(schema.message).where(eq(schema.message.id, otherSeeded[1]!.id));
            return summary('STALE');
          },
        ],
      );
      expect((await compact(other.id)).status).toBe(202);
      await background();
      expect(await compactions(other.id)).toHaveLength(0);

      // An earlier cut lands first: this one reaches further and wins.
      const third = await thread();
      const thirdSeeded = await seedTurns(third.id, 1, 6);
      script(
        [],
        [
          async () => {
            await pool.db.insert(schema.conversationCompaction).values({
              threadId: third.id,
              userId: owner,
              firstKeptMessageId: thirdSeeded[2]!.id,
              summary: 'EARLIER-CUT',
              reason: 'automatic',
              messagesSummarized: 2,
              tokensSummarized: 10,
              modelSlug: 'test-model',
            });
            return summary('FURTHER-CUT');
          },
        ],
      );
      expect((await compact(third.id)).status).toBe(202);
      await background();
      expect((await compactions(third.id)).map((record) => record.summary)).toEqual([
        'EARLIER-CUT',
        'FURTHER-CUT',
      ]);
      expect((await compactionStatus(third.id)).compaction).toMatchObject({
        reason: 'manual',
        firstKeptMessageId: thirdSeeded[6]!.id,
      });
    });
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
      expect(await response.json()).toEqual({ compaction: null, pending: true });
      await pending.running;
      // A repeat while it runs is the same request.
      const repeat = await compact(chat.id, { instructions: 'something else' });
      expect(repeat.status).toBe(202);
      expect(await repeat.json()).toEqual({ compaction: null, pending: true });
      expect(await jobs(chat.id)).toHaveLength(1);
      expect(await compactionStatus(chat.id)).toEqual({ compaction: null, pending: true });
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
      await seedTurns(chat.id, 1, 1);
      const short = await compact(chat.id);
      expect(short.status).toBe(422);
      expect(await short.text()).toContain('nothing to summarise');

      await seedTurns(chat.id, 2, 3);
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

  describe('with other features', () => {
    async function compacted() {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      script([], [summary('FORK-SUMMARY')]);
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      // The cut is at turn 3's question.
      const [record] = await compactions(chat.id);
      expect(record!.firstKeptMessageId).toBe(seeded[4]!.id);
      return { chat, seeded, record: record! };
    }
    async function copiedCompaction(threadId: string) {
      const [record] = await compactions(threadId);
      if (!record) return null;
      const [kept] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, record.firstKeptMessageId));
      return { record, kept: kept! };
    }

    it('forks and edits copy the compaction only when the cut lies within the copied messages', async () => {
      const { chat, seeded } = await compacted();
      const forkAt = async (messageId: string) => {
        const response = await app.request(`/api/threads/${chat.id}/forks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { thread: { id: string } }).thread.id;
      };
      const after = await copiedCompaction(await forkAt(seeded[7]!.id));
      expect(after?.record).toMatchObject({ summary: 'FORK-SUMMARY', tokensIn: null });
      expect(after?.kept).toMatchObject({ parentMessageId: seeded[4]!.id, role: 'user' });
      expect(after?.kept.threadId).not.toBe(chat.id);
      expect(await copiedCompaction(await forkAt(seeded[4]!.id))).not.toBeNull();
      expect(await copiedCompaction(await forkAt(seeded[3]!.id))).toBeNull();

      const editAt = async (messageId: string) => {
        const response = await app.request(`/api/threads/${chat.id}/branches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId, text: 'Edited' }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { thread: { id: string } }).thread.id;
      };
      const edited = await copiedCompaction(await editAt(seeded[6]!.id));
      expect(edited?.kept.parentMessageId).toBe(seeded[4]!.id);
      expect(await copiedCompaction(await editAt(seeded[4]!.id))).toBeNull();

      const forked = await forkAt(seeded[7]!.id);
      const model = script([textStep('From the fork')]);
      await turn(forked, 'CONTINUE');
      expect(systemOf(model.doStreamCalls[0]!.prompt)).toContain('FORK-SUMMARY');
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual([3, 4]);
    });

    it('keeps the full history in exports and share links; the JSON export includes the summary', async () => {
      const { chat, seeded, record } = await compacted();
      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id, owner);
      expect(markdown).toContain('TURN-1-QUESTION');
      expect(markdown).not.toContain('FORK-SUMMARY');

      const { exportArchive } = await import('../../services/portability/export-archive.js');
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportArchive({ id: owner })) chunks.push(chunk);
      const files = unzipSync(Buffer.concat(chunks));
      const conversations = Object.entries(files)
        .filter(([name]) => name.startsWith('conversations/') && name.endsWith('.json'))
        .map(([, bytes]) => JSON.parse(strFromU8(bytes)) as Record<string, unknown>);
      const exported = conversations.find(
        (conversation) => (conversation.thread as { id: string }).id === chat.id,
      ) as { messages: Array<{ id: string }>; compactions: unknown[] };
      expect(exported.messages.map((message) => message.id)).toEqual(seeded.map((row) => row.id));
      expect(exported.compactions).toEqual([
        expect.objectContaining({
          id: record.id,
          summary: 'FORK-SUMMARY',
          firstKeptMessageId: seeded[4]!.id,
          reason: 'manual',
        }),
      ]);

      const { createShareLink, getPublicShare } = await import('../../services/share-links.js');
      const link = await createShareLink(chat.id, owner, {});
      const shared = await getPublicShare(link.slug);
      expect(shared.messages.map((message) => message.id)).toEqual(seeded.map((row) => row.id));
      expect(JSON.stringify(shared)).not.toContain('FORK-SUMMARY');
    });

    it('goes with its conversation when the conversation is deleted', async () => {
      const { chat } = await compacted();
      await queued(chat.id);
      await pool.db.delete(schema.thread).where(eq(schema.thread.id, chat.id));
      expect(await compactions(chat.id)).toHaveLength(0);
      expect(await jobs(chat.id)).toHaveLength(0);
    });

    it('rebuilds a continued reply’s input with fewer turns after an overflow', async () => {
      state.capabilities = ['tool_calling'];
      state.settings.set('roleTools', { roles: { user: { send_note: true } } });
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      script([toolStep('w1', 'send_note', { to: 'Ada' })]);
      const { reply } = await turn(chat.id, 'Send Ada a note');
      const pending = reply.parts.find((part) => part.state === 'approval-requested') as {
        approval: { id: string };
      };
      const { setupApprovalContinuation } = await import('../../services/chat/approvals.js');
      const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
      const model = script([], [summary('unused')]);
      const { turn: continued, run } = await setupApprovalContinuation(
        { id: owner, name: 'Test', role: 'user' },
        chat.id,
        { messageId: reply.id, responses: [{ approvalId: pending.approval.id, approved: true }] },
      );
      try {
        expect(turnsIn(JSON.stringify(continued.uiMessages))).toEqual([1, 2, 3, 4]);
        const recovered = await continued.recoverOverflow!();
        expect(recovered?.contextLimited).toBe(true);
        expect(recovered?.system).not.toContain('<conversation-summary>');
        // The reply being continued is still the last message, after the kept turns.
        expect(recovered?.uiMessages.at(-1)?.id).toBe(reply.id);
        expect(turnsIn(JSON.stringify(recovered?.uiMessages))).toEqual([3, 4]);
        expect(model.doGenerateCalls).toHaveLength(0);
      } finally {
        await releaseRunHandles(run, true);
      }
    });

    it('approving while a summary is being made goes ahead; the continued reply can queue one too', async () => {
      state.capabilities = ['tool_calling'];
      state.settings.set('roleTools', { roles: { user: { send_note: true } } });
      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([toolStep('w1', 'send_note', { to: 'Ada' })]);
      const { reply } = await turn(chat.id, 'Send Ada a note');
      const pending = reply.parts.find((part) => part.state === 'approval-requested') as
        | { approval: { id: string } }
        | undefined;
      expect(pending).toBeDefined();
      expect(await jobs(chat.id)).toHaveLength(0);

      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: true });
      const making = held('APPROVAL-SUMMARY');
      const model = script([textStep('Sent.')], [making.step, summary('SPARE')]);
      expect((await compact(chat.id)).status).toBe(202);
      await making.running;
      const response = await app.request(`/api/chat/${chat.id}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: reply.id,
          responses: [{ approvalId: pending!.approval.id, approved: true }],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      const stored = await settled(chat.id);
      const continuedReply = stored.find((row) => row.id === reply.id)!;
      expect(continuedReply.status).toBe('complete');
      // It went ahead without the summary, with the oldest turns left out.
      const continued = model.doStreamCalls[0]!.prompt;
      expect(systemOf(continued)).not.toContain('<conversation-summary>');
      expect(turnsIn(promptText(continued))).not.toContain(1);
      expect(promptText(continued)).toContain('Send Ada a note');

      making.release();
      await background();
      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'manual', summary: 'APPROVAL-SUMMARY' });
      // The reply being continued and its prompt are never summarised.
      expect(promptText(model.doGenerateCalls[0]!.prompt)).not.toContain('Send Ada a note');
    });
  });
});
