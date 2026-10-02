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
 * routes, turn preparation, the reply stream, persistence and usage
 * accounting, with a scripted model in place of a provider: replies stream
 * (doStream) and summaries are generated (doGenerate).
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
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key] ?? {},
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

/** Replies and summaries, each in order. A thrown value is thrown by the call. */
function script(replies: unknown[], summaries: unknown[] = []) {
  let reply = 0;
  let summarised = 0;
  const next = (steps: unknown[], index: number) => {
    const step = steps[index];
    if (!step) throw new Error('The scripted model has no more steps');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step() : step;
  };
  const model = new MockLanguageModelV4({
    doStream: (async () => next(replies, reply++)) as never,
    doGenerate: (async () => next(summaries, summarised++)) as never,
  });
  state.model = model;
  return model;
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
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from quota_policy`);
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

  describe('automatic compaction', () => {
    it('summarises the oldest turns before the reply; the model gets the summary and the recent turns only', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 13);
      const model = script([textStep('Fresh answer')], [summary('SUMMARY-ONE', [300, 40])]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');

      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'automatic', modelSlug: 'test-model', userId: owner });
      expect(record).toMatchObject({ summary: 'SUMMARY-ONE', tokensIn: 300, tokensOut: 40 });
      const keptIndex = seeded.findIndex((row) => row.id === record!.firstKeptMessageId);
      // The cut is at a user message, after at least one turn, before the last.
      expect(seeded[keptIndex]!.role).toBe('user');
      const firstKeptTurn = keptIndex / 2 + 1;
      expect(firstKeptTurn).toBeGreaterThan(1);
      expect(firstKeptTurn).toBeLessThanOrEqual(13);
      expect(record!.messagesSummarized).toBe(keptIndex);
      expect(record!.tokensSummarized).toBeGreaterThan(0);

      // One summary call over a plain transcript of exactly the cut turns.
      expect(model.doGenerateCalls).toHaveLength(1);
      const summaryInput = promptText(model.doGenerateCalls[0]!.prompt);
      expect(turnsIn(summaryInput)).toEqual(range(1, firstKeptTurn - 1));
      expect(summaryInput).toContain('[User]: TURN-1-QUESTION');
      expect(summaryInput).toContain('[Assistant]: TURN-1-ANSWER');
      expect(summaryInput).not.toContain('NEW QUESTION');
      expect(summaryInput).toContain('## Critical details');

      // The reply: summary in the system prompt, then the kept turns verbatim.
      const replyInput = model.doStreamCalls[0]!.prompt;
      expect(systemOf(replyInput)).toContain('BASE_SYSTEM_PROMPT');
      expect(systemOf(replyInput)).toContain('<conversation-summary>');
      expect(systemOf(replyInput)).toContain('SUMMARY-ONE');
      expect(turnsIn(promptText(replyInput))).toEqual(range(firstKeptTurn, 13));
      expect(promptText(replyInput)).toContain('NEW QUESTION');

      // Compaction replaces the "earlier context was omitted" note.
      expect(reply.status).toBe('complete');
      expect(reply.parts.some((part) => part.type === 'data-context-window')).toBe(false);

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
      // The reply's own event is separate and counts the message.
      const [run] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, reply.id));
      expect(run).toMatchObject({ messageCount: 1, tokensIn: 20, tokensOut: 7 });

      // Every message is still stored, unchanged.
      expect((await rows(chat.id)).length).toBe(seeded.length + 2);
      const shown = await app.request(`/api/threads/${chat.id}/compaction`);
      expect(await shown.json()).toEqual({
        compaction: expect.objectContaining({
          id: record!.id,
          firstKeptMessageId: record!.firstKeptMessageId,
          summary: 'SUMMARY-ONE',
          reason: 'automatic',
        }),
      });

      // The next turn fits beside the summary: no new compaction.
      script([textStep('Another')], []);
      await turn(chat.id, 'FOLLOW UP');
      expect(await compactions(chat.id)).toHaveLength(1);
      expect(systemOf((state.model as MockLanguageModelV4).doStreamCalls[0]!.prompt)).toContain(
        'SUMMARY-ONE',
      );
    });

    it('feeds the previous summary into the next compaction, starting at the previous cut', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([textStep('One')], [summary('SUMMARY-ONE')]);
      await turn(chat.id, 'FIRST NEW');
      const [first] = await compactions(chat.id);
      const stored = await rows(chat.id);
      const firstKept = stored.findIndex((row) => row.id === first!.firstKeptMessageId);
      const firstKeptTurn = firstKept / 2 + 1;

      await seedTurns(chat.id, 14, 26);
      // A backlog larger than one summariser input is summarised in parts,
      // each carrying the summary so far.
      const parts = ['SUMMARY-TWO-A', 'SUMMARY-TWO-B', 'SUMMARY-TWO-C'];
      const model = script(
        [textStep('Two')],
        parts.map((text) => summary(text)),
      );
      await turn(chat.id, 'SECOND NEW');
      const records = await compactions(chat.id);
      expect(records).toHaveLength(2);
      const calls = model.doGenerateCalls.map((call) => promptText(call.prompt));
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const second = records[1]!;
      expect(second.summary).toBe(parts[calls.length - 1]);
      expect(second.messagesSummarized).toBeGreaterThan(first!.messagesSummarized);
      // Usage of every call is the compaction's.
      expect(second.tokensIn).toBe(300 * calls.length);

      expect(calls[0]).toContain('<previous-summary>\\nSUMMARY-ONE\\n</previous-summary>');
      for (const [index, call] of calls.entries())
        if (index > 0) expect(call).toContain(`<previous-summary>\\n${parts[index - 1]}\\n`);
      // The new transcript starts where the previous summary ended, in order.
      const summarisedTurns = calls.flatMap(turnsIn);
      expect(summarisedTurns[0]).toBe(firstKeptTurn);
      expect(summarisedTurns).toEqual(range(firstKeptTurn, summarisedTurns.at(-1)!));
      expect(calls.join('\n')).toContain('FIRST NEW');
      expect(calls.join('\n')).not.toContain(`TURN-${firstKeptTurn - 1}-`);

      const system = systemOf(model.doStreamCalls[0]!.prompt);
      expect(system).toContain(second.summary);
      expect(system).not.toContain('SUMMARY-ONE');
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))[0]).toBeGreaterThan(
        summarisedTurns.at(-1)!,
      );
    });

    it('leaves the oldest turns out, as before, when an administrator switched it off', async () => {
      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      const model = script([textStep('Answer')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(await compactions(chat.id)).toHaveLength(0);
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'data-context-window', data: { limited: true } }),
      );
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).not.toContain(1);
    });

    it('goes ahead without a summary when the summary call fails, recording what it can', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      const model = script([textStep('Answer')], [new Error('summariser down')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(await compactions(chat.id)).toHaveLength(0);
      expect(reply.status).toBe('complete');
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'data-context-window', data: { limited: true } }),
      );
    });
  });

  describe('manual compaction', () => {
    it('summarises with the person’s instructions, and later turns use it even with automatic compaction off', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const model = script([], [summary('MANUAL-SUMMARY', [120, 30])]);
      const response = await compact(chat.id, { instructions: 'keep the budget figures' });
      expect(response.status).toBe(201);
      const { compaction } = (await response.json()) as {
        compaction: { id: string; reason: string; firstKeptMessageId: string };
      };
      // A request summarises at least half of a short conversation.
      expect(compaction).toMatchObject({ reason: 'manual', firstKeptMessageId: seeded[4]!.id });
      const summaryInput = promptText(model.doGenerateCalls[0]!.prompt);
      expect(summaryInput).toContain('focus on: keep the budget figures');
      expect(turnsIn(summaryInput)).toEqual([1, 2]);
      const [event] = await pool.db
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.id, compaction.id));
      expect(event).toMatchObject({ messageCount: 0, tokensIn: 120, tokensOut: 30 });

      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const next = script([textStep('Answer')]);
      await turn(chat.id, 'NEXT');
      expect(systemOf(next.doStreamCalls[0]!.prompt)).toContain('MANUAL-SUMMARY');
      expect(turnsIn(promptText(next.doStreamCalls[0]!.prompt))).toEqual([3, 4]);
    });

    it('refuses with nothing to summarise, while a reply is generating, and for someone else', async () => {
      const chat = await thread();
      script([], [summary('unused')]);
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
      await pool.db.insert(schema.message).values({
        threadId: chat.id,
        userId: owner,
        role: 'assistant',
        parts: [],
        position: 100,
        status: 'streaming',
      });
      const busy = await compact(chat.id);
      expect(busy.status).toBe(409);
      expect(await compactions(chat.id)).toHaveLength(0);
      expect((state.model as MockLanguageModelV4).doGenerateCalls).toHaveLength(0);
      // Invalid instructions are refused before anything else.
      await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
      expect((await compact(chat.id, { instructions: 'x'.repeat(2001) })).status).toBe(422);
      expect((await compact(chat.id, { other: true })).status).toBe(422);
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

      // The summariser's own input would not fit this model.
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
      // Nothing was spent, so nothing is recorded.
      expect(await events()).toBe(before);

      state.contextWindow = 16_000;
      const model = script([], [summary('WITH-FILES')]);
      expect((await compact(chat.id)).status).toBe(201);
      const transcript = promptText(model.doGenerateCalls[0]!.prompt);
      expect(transcript).toContain('[User attached]: budget.pdf');
      // File contents are not copied into the summariser's input.
      expect(transcript).not.toContain('EXTRACTED_TEXT');
    });

    it('reports a conflict when another compaction was recorded while summarising', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      script(
        [],
        [
          async () => {
            // Someone else's compaction lands first.
            await pool.db.insert(schema.conversationCompaction).values({
              threadId: chat.id,
              userId: owner,
              firstKeptMessageId: seeded[2]!.id,
              summary: 'RACING',
              reason: 'manual',
              messagesSummarized: 2,
              tokensSummarized: 10,
              modelSlug: 'test-model',
            });
            return summary('LOSING');
          },
        ],
      );
      const response = await compact(chat.id);
      expect(response.status).toBe(409);
      expect((await compactions(chat.id)).map((record) => record.summary)).toEqual(['RACING']);
    });

    it('is refused when the person’s allowance is spent, and reports a failed summary', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const chat = await thread(person);
      await seedTurns(chat.id, 1, 3, person);
      script([], [new Error('provider down')]);
      const failed = await compact(chat.id, {}, person);
      expect(failed.status).toBe(502);
      expect(await compactions(chat.id)).toHaveLength(0);

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
      const model = script([], [summary('unused')]);
      expect((await compact(chat.id, {}, person)).status).toBe(429);
      expect(model.doGenerateCalls).toHaveLength(0);
    });
  });

  describe('overflow recovery', () => {
    it('compacts once and retries once when the provider says the input is too long', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script([overflow(), textStep('Recovered')], [summary('OVERFLOW-SUMMARY')]);
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual([1, 2, 3, 4]);
      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'overflow', summary: 'OVERFLOW-SUMMARY' });
      const retry = model.doStreamCalls[1]!.prompt;
      expect(systemOf(retry)).toContain('OVERFLOW-SUMMARY');
      expect(turnsIn(promptText(retry))).not.toContain(1);
      // The prompt is sent once, never duplicated by the rebuild.
      expect(promptText(retry).match(/NEW QUESTION/g)).toHaveLength(1);
      expect(reply).toMatchObject({ status: 'complete' });
      expect(reply.parts).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Recovered' }),
      );
    });

    it('does not loop: a second overflow fails the reply after one compaction', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script(
        [overflow(), overflow(), textStep('never')],
        [summary('S'), summary('T')],
      );
      const { reply } = await turn(chat.id, 'NEW QUESTION');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(await compactions(chat.id)).toHaveLength(1);
      expect(reply.status).toBe('error');
    });

    it('fails as before when there is nothing to compact, or automatic compaction is off', async () => {
      const chat = await thread();
      const model = script([overflow()], [summary('unused')]);
      const { reply } = await turn(chat.id, 'FIRST QUESTION');
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(reply.status).toBe('error');

      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const other = await thread();
      await seedTurns(other.id, 1, 4);
      const off = script([overflow()], [summary('unused')]);
      expect((await turn(other.id, 'NEW')).reply.status).toBe('error');
      expect(off.doGenerateCalls).toHaveLength(0);
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
      expect((await compact(chat.id)).status).toBe(201);
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
      // It points at the fork's own copy of turn 3's question.
      expect(after?.kept).toMatchObject({ parentMessageId: seeded[4]!.id, role: 'user' });
      expect(after?.kept.threadId).not.toBe(chat.id);
      // Forking at the cut itself keeps it; before the cut there is nothing to copy.
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
      // Editing turn 4 copies turn 3, where the cut is.
      const edited = await copiedCompaction(await editAt(seeded[6]!.id));
      expect(edited?.kept.parentMessageId).toBe(seeded[4]!.id);
      // Editing turn 3 replaces the first kept message: the summary is not copied.
      expect(await copiedCompaction(await editAt(seeded[4]!.id))).toBeNull();

      // A fork's summary is used for its next reply.
      const forked = await forkAt(seeded[7]!.id);
      const model = script([textStep('From the fork')]);
      await turn(forked, 'CONTINUE');
      expect(systemOf(model.doStreamCalls[0]!.prompt)).toContain('FORK-SUMMARY');
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual([3, 4]);
    });

    it('keeps the full history in exports and share links; the JSON export includes the summary', async () => {
      const { chat, seeded, record } = await compacted();
      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id);
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
      await pool.db.delete(schema.thread).where(eq(schema.thread.id, chat.id));
      expect(await compactions(chat.id)).toHaveLength(0);
    });

    it('rebuilds a continued reply’s input with a compaction after an overflow', async () => {
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
      // The continuation resolves its model now; the summary comes from it.
      script([], [summary('CONTINUATION-SUMMARY')]);
      const { turn: continued, run } = await setupApprovalContinuation(
        { id: owner, name: 'Test', role: 'user' },
        chat.id,
        { messageId: reply.id, responses: [{ approvalId: pending.approval.id, approved: true }] },
      );
      try {
        expect(continued.system).not.toContain('<conversation-summary>');
        const recovered = await continued.recoverOverflow!();
        expect(recovered?.system).toContain('CONTINUATION-SUMMARY');
        // The reply being continued is still the last message, after the kept turns.
        expect(recovered?.uiMessages.at(-1)?.id).toBe(reply.id);
        expect(turnsIn(JSON.stringify(recovered?.uiMessages))).not.toContain(1);
        const [record] = await compactions(chat.id);
        expect(record).toMatchObject({ reason: 'overflow' });
      } finally {
        await releaseRunHandles(run, true);
      }
    });

    it('applies when a reply continues after its approvals are answered', async () => {
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
      expect(await compactions(chat.id)).toHaveLength(0);

      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: true });
      const model = script([textStep('Sent.')], [summary('APPROVAL-SUMMARY')]);
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
      expect(stored.find((row) => row.id === reply.id)?.status).toBe('complete');
      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'automatic', summary: 'APPROVAL-SUMMARY' });
      // The continuing reply and its prompt are never summarised.
      const summaryInput = promptText(model.doGenerateCalls[0]!.prompt);
      expect(summaryInput).not.toContain('Send Ada a note');
      const continued = model.doStreamCalls[0]!.prompt;
      expect(systemOf(continued)).toContain('APPROVAL-SUMMARY');
      expect(turnsIn(promptText(continued))).not.toContain(1);
      expect(promptText(continued)).toContain('Send Ada a note');
    });
  });
});
