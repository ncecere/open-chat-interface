import { randomUUID } from 'node:crypto';
import { type createDatabase, eq, schema } from '@oci/db';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared by the chat-compaction*.live.test.ts suites: a scripted model in place
 * of a provider (replies stream with doStream, summaries come from doGenerate),
 * the chat and thread routes, and helpers that seed and read conversations.
 * Each suite declares its own mocks and creates its own database.
 */

export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
export function textStep(text: string) {
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
export function toolStep(id: string, tool: string, input: unknown) {
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
export function overflow() {
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
export function summary(text: string, [input, output]: [number, number] = [300, 40]) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: usage(input, output),
    warnings: [],
  };
}

/**
 * Returns `script` bound to a suite's hoisted mock state: replies and
 * summaries, each in order. A thrown value is thrown by the call. `events`
 * records the order of reply and summary calls.
 */
export function scriptFor(state: { model: unknown }) {
  return function script(replies: unknown[], summaries: unknown[] = []) {
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
  };
}
/** A summary that is only returned once `release` is called. */
export function held(text: string) {
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
export const promptText = (prompt: unknown) => JSON.stringify(prompt);
export const systemOf = (prompt: unknown) =>
  (prompt as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');

/** One long turn of about 1,100 input units, with markers to find it by. */
export const question = (turn: number) => `TURN-${turn}-QUESTION ${'q'.repeat(480)}`;
export const answer = (turn: number) => `TURN-${turn}-ANSWER ${'a'.repeat(480)}`;

/** The chat and thread routes, signed in as `x-test-user` or else the owner. */
export async function compactionApp(organizationId: string, owner: string) {
  const { chatRoutes } = await import('../src/routes/chat.js');
  const { threadRoutes } = await import('../src/routes/threads.js');
  const { errorHandler } = await import('../src/middleware/error-handler.js');
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-test-user') ?? owner,
      name: 'Test',
      email: 'test@example.test',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId,
    });
    await next();
  });
  app.route('/api/chat', chatRoutes);
  app.route('/api/threads', threadRoutes);
  return app;
}

/** What the helpers need from a suite; read when a helper runs, after `beforeAll`. */
export interface CompactionSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly app: Hono<AppBindings>;
  readonly owner: string;
  readonly organizationId: string;
}

export function compactionHelpers(suite: CompactionSuite) {
  async function thread(user = suite.owner) {
    const [row] = await suite.pool.db
      .insert(schema.thread)
      .values({ userId: user, organizationId: suite.organizationId, title: 'Long chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return suite.pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function compactions(threadId: string) {
    return suite.pool.db
      .select()
      .from(schema.conversationCompaction)
      .where(eq(schema.conversationCompaction.threadId, threadId))
      .orderBy(schema.conversationCompaction.createdAt);
  }
  /** Stores turns `from`..`to` after whatever the thread already has. */
  async function seedTurns(threadId: string, from: number, to: number, user = suite.owner) {
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
    await suite.pool.db.insert(schema.message).values(values);
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
  async function turn(threadId: string, text: string, user = suite.owner) {
    const response = await suite.app.request('/api/chat', {
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
    return suite.pool.db
      .select()
      .from(schema.conversationCompactionJob)
      .where(eq(schema.conversationCompactionJob.threadId, threadId));
  }
  /** Waits for this process's background compaction pass to finish. */
  async function background() {
    const { compactionQueueSettled } = await import('../src/services/chat/compaction-queue.js');
    await compactionQueueSettled();
  }
  async function processQueue() {
    const { processCompactionQueue } = await import('../src/services/chat/compaction-queue.js');
    return processCompactionQueue();
  }
  async function compactionStatus(threadId: string, user = suite.owner) {
    const response = await suite.app.request(`/api/threads/${threadId}/compaction`, {
      headers: { 'x-test-user': user },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      compaction: { id: string; reason: string; firstKeptMessageId: string } | null;
      pending: boolean;
      failure: { reason: string; instructions: string | null; failedAt: string } | null;
      summarisable: boolean;
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
    user = suite.owner,
  ) {
    await suite.pool.db.insert(schema.conversationCompactionJob).values({
      threadId,
      userId: user,
      reason: 'manual',
      modelSlug: 'test-model',
      ...values,
    });
  }
  function compact(threadId: string, body: Record<string, unknown> = {}, user = suite.owner) {
    return suite.app.request(`/api/threads/${threadId}/compact`, {
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
    const response = await suite.app.request('/api/chat', {
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

  return {
    thread,
    rows,
    compactions,
    seedTurns,
    settled,
    turn,
    jobs,
    background,
    processQueue,
    compactionStatus,
    snapshot,
    queued,
    compact,
    turnsIn,
    range,
    retry,
    limitedMark,
  };
}
