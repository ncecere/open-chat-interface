import { createDatabase, eq, schema, sql } from '@oci/db';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * A reply whose producer died (the API replica was killed mid-reply, as the
 * rolling-upgrade test's SIGKILL after the grace period does), through real
 * PostgreSQL, real Redis and the real chat routes. Before v0.11 such a reply
 * stayed `streaming` for ever: a client resuming it waited on a stream nobody
 * would finish, and the conversation refused every new message (409).
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    loadEnv: () => ({
      ...original.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
      CHAT_STREAM_TTL_SECONDS: 120,
    }),
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) =>
    key === 'features'
      ? { webSearch: false, attachments: true, temporaryChat: true, branching: true }
      : key === 'roleFeatures'
        ? {
            roles: Object.fromEntries(
              ['admin', 'auditor', 'user', 'restricted'].map((r) => [r, { artifacts: false }]),
            ),
          }
        : {},
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};
async function redisAvailable() {
  const probe = new Redis(redisUrl, redisOptions);
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = (await livePostgresAvailable()) && (await redisAvailable());

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
function textModel(text: string) {
  state.model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: text },
        { type: 'text-end' as const, id: 't' },
        {
          type: 'finish' as const,
          usage: usage as never,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
        },
      ]),
    }),
  });
}
const frame = (chunk: Record<string, unknown>) => `data: ${JSON.stringify(chunk)}\n\n`;

/**
 * Reads a response body to its end; `ended` is false when it was still open
 * after `ms` (the reader then closes because its request was aborted).
 */
async function readWithin(response: Response, ms: number, abort: AbortController) {
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    const text = await response.text();
    return { text, ended: !abort.signal.aborted };
  } catch {
    return { text: '', ended: false };
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!available)('live recovery of a reply whose producer died', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const redis = new Redis(redisUrl, redisOptions);
  let owner: string;
  let app: Hono<AppBindings>;
  const requests: AbortController[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('chat_interrupted_reply');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    await redis.connect();
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: owner,
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
  });
  afterEach(() => {
    for (const abort of requests.splice(0)) abort.abort();
  });
  afterAll(async () => {
    redis.disconnect();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  /**
   * What a killed producer leaves: a prompt, a streaming assistant claim last
   * written `silentFor` ago, its pending usage reservation and, unless
   * `cached` is false, its Redis stream with the first part of the reply.
   */
  async function orphan({
    silentFor = 120_000,
    cached = true,
    eventsAgo = silentFor,
  }: {
    silentFor?: number;
    cached?: boolean;
    eventsAgo?: number;
  } = {}) {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Cut reply' })
      .returning();
    const [prompt] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId: owner,
        role: 'user',
        position: 0,
        parts: [{ type: 'text', text: 'Tell me something' }],
      })
      .returning();
    const [claim] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId: owner,
        role: 'assistant',
        position: 1,
        parentMessageId: prompt!.id,
        status: 'streaming',
        modelSlug: 'test-model',
        parts: [],
      })
      .returning();
    await pool.db.execute(
      sql`update message set updated_at = now() - make_interval(secs => ${silentFor / 1000}::double precision) where id = ${claim!.id}`,
    );
    await pool.db.insert(schema.usageEvent).values({
      id: claim!.id,
      organizationId: state.organizationId,
      userId: owner,
      modelSlug: 'test-model',
      pending: true,
      reservedTokens: 50,
    });
    const identity = { runId: claim!.id, threadId: thread!.id, userId: owner };
    if (cached) {
      const { ChatStreamStore } = await import('../../services/chat-streams.js');
      expect(await new ChatStreamStore(redis, 120).begin(identity)).toBe('available');
      const events = `oci:chat-stream:run:${identity.runId}:events`;
      const at = Date.now() - eventsAgo;
      const frames = [
        frame({ type: 'start', messageId: identity.runId }),
        frame({ type: 'text-start', id: 't' }),
        frame({ type: 'text-delta', id: 't', delta: 'The first half of an answer' }),
      ];
      for (const [index, data] of frames.entries())
        await redis.xadd(events, `${at}-${index + 1}`, 'seq', String(index + 1), 'data', data);
      await redis.hset(`oci:chat-stream:run:${identity.runId}:metadata`, 'lastSequence', '3');
    }
    return { identity, claimId: claim!.id, threadId: thread!.id };
  }
  async function stored(id: string) {
    const [row] = await pool.db.select().from(schema.message).where(eq(schema.message.id, id));
    return row!;
  }
  function resume(threadId: string) {
    const abort = new AbortController();
    requests.push(abort);
    return {
      abort,
      response: app.request(`/api/chat/${threadId}/stream`, { signal: abort.signal }),
    };
  }

  it('ends a resuming client with what was captured and saves the reply as interrupted', async () => {
    const { identity, threadId, claimId } = await orphan();
    const { response, abort } = resume(threadId);
    const opened = await response;
    expect(opened.status).toBe(200);
    // Before: the reader replayed the prefix, then waited for a producer that
    // no longer existed until the client gave up.
    const body = await readWithin(opened, 8_000, abort);
    expect(body.ended).toBe(true);
    expect(body.text).toContain('The first half of an answer');
    expect(body.text).not.toContain('Live replay is no longer available');

    const reply = await stored(claimId);
    expect(reply.status).toBe('cancelled');
    expect(reply.errorMessage).toMatch(/interrupted/i);
    // What the person saw is kept, rebuilt from the captured stream.
    expect(reply.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'The first half of an answer', state: 'done' }),
    ]);
    expect(await redis.hget(`oci:chat-stream:run:${identity.runId}:metadata`, 'status')).toBe(
      'cancelled',
    );
    expect(await redis.get(`oci:chat-stream:thread:${threadId}:active`)).toBeNull();
    const [event] = await pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.id, claimId));
    // Settled as unknown usage, its estimate still held, as the quota sweep does.
    expect(event).toMatchObject({ pending: false, usageUnknown: true });
  }, 15_000);

  it('accepts a new message in a conversation whose reply was cut', async () => {
    const { threadId, claimId } = await orphan({ cached: false });
    textModel('A fresh answer');
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Are you there?' }] }],
      }),
    });
    // Before: 409 "A response is already being generated" for ever.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('A fresh answer');
    expect((await stored(claimId)).status).toBe('cancelled');
    await vi.waitFor(
      async () => {
        const rows = await pool.db
          .select()
          .from(schema.message)
          .where(eq(schema.message.threadId, threadId));
        expect(rows.filter((row) => row.status === 'streaming')).toHaveLength(0);
        expect(
          rows.find((row) => row.parts.some((p) => p.text === 'A fresh answer')),
        ).toBeDefined();
      },
      { timeout: 5_000, interval: 25 },
    );
  });

  it.each([
    ['its PostgreSQL heartbeat is recent', { silentFor: 1_000 }],
    // A release before v0.11 has no heartbeat; its captured events show it is alive.
    ['it captured an event just now', { eventsAgo: 0 }],
  ])('leaves a reply alone while %s', async (_case, options) => {
    const { threadId, claimId } = await orphan(options);
    const { response, abort } = resume(threadId);
    const opened = await response;
    expect(opened.status).toBe(200);
    const body = await readWithin(opened, 1_500, abort);
    expect(body.ended).toBe(false);
    expect((await stored(claimId)).status).toBe('streaming');
  });

  it('leaves a reply alone while its Redis heartbeat lives, even if PostgreSQL is silent', async () => {
    const { identity, threadId, claimId } = await orphan();
    await redis.set(`oci:chat-stream:run:${identity.runId}:alive`, '1', 'PX', 30_000);
    textModel('Unused');
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello?' }] }],
      }),
    });
    expect(response.status).toBe(409);
    expect((await stored(claimId)).status).toBe('streaming');
  });

  it('counts down to when recovery can happen, waiting for Redis as well as the claim (#163)', async () => {
    // As a crash leaves it: the claim (refreshed every 10 s) silent for 15 s,
    // so 5 s from stale by itself; the Redis heartbeat (every 5 s, 20 s TTL)
    // with 12 s to live, and the last event 2 s old (18 s from stale).
    const { identity, threadId, claimId } = await orphan({ silentFor: 15_000, eventsAgo: 2_000 });
    await redis.set(`oci:chat-stream:run:${identity.runId}:alive`, '1', 'PX', 12_000);
    textModel('Unused');
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Walk3 probe' }] }],
      }),
    });
    expect(response.status).toBe(409);
    const seconds = Number(response.headers.get('retry-after'));
    // Not the claim's 5 s, after which the client was refused again and again.
    expect(seconds).toBeGreaterThanOrEqual(17);
    expect(seconds).toBeLessThanOrEqual(18);
    expect(await response.text()).toContain(`Send your message again in ${seconds} seconds.`);
    expect((await stored(claimId)).status).toBe('streaming');
  });

  it('sweeps interrupted replies nobody is reading, and frees their slot', async () => {
    const { recoverInterruptedReplies } = await import('../../services/chat/run-recovery.js');
    const dead = await orphan();
    const alive = await orphan({ silentFor: 1_000 });
    const slots = `oci:concurrency:user:${owner}`;
    await redis.zadd(slots, Date.now() + 60_000, dead.identity.runId);
    expect(await recoverInterruptedReplies()).toBeGreaterThanOrEqual(1);
    expect((await stored(dead.claimId)).status).toBe('cancelled');
    expect((await stored(alive.claimId)).status).toBe('streaming');
    expect(await redis.zscore(slots, dead.identity.runId)).toBeNull();
    // Already recovered: a second sweep (or another replica) does nothing to it.
    const { recoverInterruptedRun } = await import('../../services/chat/run-recovery.js');
    expect(await recoverInterruptedRun(dead.identity)).toBe(false);
  });

  it('keeps a long reply alive with its heartbeat, and a stop is not an interruption', async () => {
    const { runLiveness, recoverInterruptedReplies } = await import(
      '../../services/chat/run-recovery.js'
    );
    const saved = { ...runLiveness };
    Object.assign(runLiveness, { heartbeatMs: 100, staleMs: 600 });
    try {
      const [thread] = await pool.db
        .insert(schema.thread)
        .values({ organizationId: state.organizationId, userId: owner, title: 'Long reply' })
        .returning();
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      state.model = new MockLanguageModelV4({
        doStream: (async (options: { abortSignal?: AbortSignal }) => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'Thinking it over' });
              started();
              options.abortSignal?.addEventListener('abort', () =>
                controller.error(new DOMException('The operation was aborted.', 'AbortError')),
              );
            },
          }),
        })) as never,
      });
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: thread!.id,
          modelSlug: 'test-model',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Take your time' }] }],
        }),
      });
      const reading = response.text();
      await running;
      // Silent for longer than staleMs, but heartbeating. (The sweep may end
      // earlier tests' orphans, now stale under the shortened window.)
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await recoverInterruptedReplies();
      const claimId = response.headers.get('X-OCI-Chat-Run-Id')!;
      expect((await stored(claimId)).status).toBe('streaming');
      await app.request(`/api/chat/${thread!.id}/stream`, { method: 'DELETE' });
      await reading;
      await vi.waitFor(async () => expect((await stored(claimId)).status).toBe('cancelled'), {
        timeout: 5_000,
        interval: 25,
      });
      expect((await stored(claimId)).errorMessage).toBeNull();
    } finally {
      Object.assign(runLiveness, saved);
    }
  }, 15_000);
});
