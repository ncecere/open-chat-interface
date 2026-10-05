import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { serve } from '@hono/node-server';
import { createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { startRateLimitedProvider } from '../../../test/rate-limited-provider.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Provider capacity (v0.11 design, item 15) through the chat route, a real
 * HTTP server, PostgreSQL, Redis and an OpenAI-compatible model server that
 * enforces its own limits with 429 and Retry-After.
 *
 * Reproduced first: before item 15, ten turns sent at once to a provider that
 * allows two streams failed eight (the AI SDK's two retries, 1 s apart as the
 * provider asked, ran out); with the provider's limit configured they now
 * wait their turn and all complete.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  baseUrl: '',
  capacity: {} as Record<string, unknown>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
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
const PROVIDER_ID = `stub-provider-${process.pid}-${Date.now()}`;
const MODEL_ID = `stub-model-${process.pid}`;
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    modelId: MODEL_ID,
    providerId: PROVIDER_ID,
    providerLabel: 'Stub',
    displayName: 'Stub Model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai-compatible',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: createOpenAICompatible({
      name: 'stub',
      baseURL: state.baseUrl,
      includeUsage: true,
    })('stub-model'),
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
        : key === 'providerCapacity'
          ? state.capacity
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

const providerLimits = (
  maxConcurrentStreams: number | null,
  extra: Record<string, unknown> = {},
) => ({
  providers: {
    [PROVIDER_ID]: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrentStreams },
  },
  ...extra,
});

describe.skipIf(!available)('live provider capacity', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const redis = new Redis(redisUrl, redisOptions);
  let people: { a: string; b: string };
  let server: Server;
  let base: string;
  let stub: Awaited<ReturnType<typeof startRateLimitedProvider>>;

  beforeAll(async () => {
    live = await createLiveDatabase('provider_capacity');
    pool = createDatabase(live.connectionString, { max: 16 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    people = {
      a: await seedUser(pool.db, state.organizationId),
      b: await seedUser(pool.db, state.organizationId),
    };
    await redis.connect();
    stub = await startRateLimitedProvider();
    state.baseUrl = stub.baseUrl;
  });

  beforeEach(async () => {
    const drain = await import('../../lib/drain.js');
    const runs = await import('../../services/chat/active-runs.js');
    const capacity = await import('../../services/limits/capacity/index.js');
    const { resetMetrics } = await import('../../services/observability/metrics.js');
    drain.resetDrainForTests();
    runs.resetActiveRunsForTests();
    capacity.resetCapacityForTests();
    resetMetrics();
    const keys = await redis.keys(`oci:capacity:{${PROVIDER_ID}}:*`);
    if (keys.length) await redis.del(...keys);
    stub.reset();
    state.capacity = {};
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('/api/chat/*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? people.a,
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
    server = await new Promise<Server>((resolve) => {
      const started = serve(
        { fetch: drain.withDrain(app.fetch), port: 0, hostname: '127.0.0.1' },
        () => resolve(started as Server),
      ) as Server;
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  afterAll(async () => {
    redis.disconnect();
    await stub?.close();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread(userId = people.a) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId, title: 'Capacity' })
      .returning();
    return row!.id;
  }
  function send(
    threadId: string,
    text: string,
    userId = people.a,
    extra: Record<string, unknown> = {},
  ) {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        threadId,
        modelSlug: 'stub',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        ...extra,
      }),
    });
  }
  async function assistants(threadId: string) {
    return (
      await pool.db.select().from(schema.message).where(eq(schema.message.threadId, threadId))
    ).filter((row) => row.role === 'assistant');
  }
  /** Reads a reply stream until `done(text)` holds (or it ends). */
  async function readUntil(body: ReadableStream<Uint8Array>, done: (text: string) => boolean) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!done(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return {
      text,
      cancel: () => reader.cancel(),
      rest: async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return text;
          text += decoder.decode(chunk.value, { stream: true });
        }
      },
    };
  }
  const settled = async (threadId: string) => {
    for (let i = 0; i < 100; i++) {
      const rows = await assistants(threadId);
      if (rows.length && rows.every((row) => row.status !== 'streaming')) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return assistants(threadId);
  };

  it('without limits, turns over the provider’s limit fail', async () => {
    stub.configure({ maxConcurrent: 2, retryAfterSeconds: 1, chunks: 10, chunkDelayMs: 300 });
    const threads = await Promise.all(Array.from({ length: 10 }, () => thread()));
    const replies = await Promise.all(threads.map((id, index) => send(id, `turn ${index}`)));
    await Promise.all(replies.map((reply) => reply.text()));
    const statuses = await Promise.all(threads.map(async (id) => (await settled(id))[0]!.status));
    expect(stub.stats.refused).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 'error').length).toBeGreaterThanOrEqual(4);
    const { providerThrottles } = await import('../../services/observability/metrics.js');
    expect(providerThrottles.get({ provider: 'Stub', model: 'stub', status: '429' })).toBe(
      stub.stats.refused,
    );
  }, 30_000);

  it('with the limit configured, the same turns wait their turn and all complete', async () => {
    stub.configure({ maxConcurrent: 2, retryAfterSeconds: 1, chunks: 10, chunkDelayMs: 100 });
    state.capacity = providerLimits(2);
    const threads = await Promise.all(Array.from({ length: 10 }, () => thread()));
    const replies = await Promise.all(threads.map((id, index) => send(id, `turn ${index}`)));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    const texts = await Promise.all(replies.map((reply) => reply.text()));
    const statuses = await Promise.all(threads.map(async (id) => (await settled(id))[0]!.status));
    expect(statuses).toEqual(Array(10).fill('complete'));
    expect(stub.stats.refused).toBe(0);
    expect(stub.stats.maxActive).toBe(2);
    // Eight waited, and their readers saw their place before the reply began.
    const waited = texts.filter((text) => text.includes('"type":"data-capacity"'));
    expect(waited).toHaveLength(8);
    for (const text of waited) {
      expect(text).toMatch(/"state":"waiting","model":"Stub Model","position":\d/);
      expect(text.indexOf('"state":"admitted"')).toBeLessThan(text.indexOf('part0'));
    }
    const { providerQueueWaits } = await import('../../services/observability/metrics.js');
    expect(providerQueueWaits.get({ provider: 'Stub', model: 'stub', outcome: 'admitted' })).toBe(
      8,
    );
    // Nothing is left behind in Redis.
    expect(await redis.zcard(`oci:capacity:{${PROVIDER_ID}}:q`)).toBe(0);
    expect(await redis.zcard(`oci:capacity:{${PROVIDER_ID}}:p:st`)).toBe(0);
  }, 30_000);

  it('is fair across people: one person’s many turns do not hold another’s back', async () => {
    stub.configure({ maxConcurrent: 1, chunks: 4, chunkDelayMs: 100 });
    state.capacity = providerLimits(1);
    const aThreads = await Promise.all(Array.from({ length: 6 }, () => thread(people.a)));
    const bThreads = await Promise.all(Array.from({ length: 2 }, () => thread(people.b)));
    const aReplies = aThreads.map((id, index) => send(id, `A${index}`, people.a));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const bReplies = bThreads.map((id, index) => send(id, `B${index}`, people.b));
    await Promise.all([...aReplies, ...bReplies].map(async (reply) => (await reply).text()));
    expect(stub.stats.maxActive).toBe(1);
    expect(stub.stats.started).toHaveLength(8);
    // Start order: the person with one turn waiting goes next, not after all six.
    const bPositions = stub.stats.started
      .map((text, index) => (text.startsWith('B') ? index : -1))
      .filter((index) => index >= 0);
    expect(bPositions[0]).toBeLessThanOrEqual(2);
    expect(bPositions[1]).toBeLessThanOrEqual(4);
  }, 30_000);

  it('Stop removes a waiting turn from the queue', async () => {
    stub.configure({ maxConcurrent: 1, chunks: 15, chunkDelayMs: 100 });
    state.capacity = providerLimits(1);
    const first = await thread();
    const second = await thread();
    const running = await send(first, 'first');
    await readUntil(running.body!, (text) => text.includes('part0'));
    const waiting = await send(second, 'second');
    const seen = await readUntil(waiting.body!, (text) => text.includes('"state":"waiting"'));
    expect(seen.text).toContain('"position":1');
    expect(await redis.zcard(`oci:capacity:{${PROVIDER_ID}}:q`)).toBe(1);

    // Another reader, as after a reload: the place is replayed from Redis.
    const resumed = await fetch(`${base}/api/chat/${second}/stream`);
    const replay = await readUntil(resumed.body!, (text) => text.includes('"state":"waiting"'));
    expect(replay.text).toContain('"type":"data-capacity"');

    const stopped = await fetch(`${base}/api/chat/${second}/stream`, { method: 'DELETE' });
    expect(await stopped.json()).toEqual({ cancelled: true });
    await seen.rest();
    expect(await redis.zcard(`oci:capacity:{${PROVIDER_ID}}:q`)).toBe(0);
    const [stoppedReply] = await settled(second);
    expect(stoppedReply).toMatchObject({ status: 'cancelled', errorMessage: null });
    // The stopped turn never reached the provider, and its reservation is released.
    expect(stub.stats.started).toEqual(['first']);
    const [event] = await pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.id, stoppedReply!.id));
    expect(event).toBeUndefined();
  }, 30_000);

  it('fails a turn that waits past the maximum, with a clear message', async () => {
    stub.configure({ maxConcurrent: 1, chunks: 80, chunkDelayMs: 100 });
    state.capacity = providerLimits(1, { queue: { maxWaitSeconds: 5 } });
    const first = await thread();
    const second = await thread();
    const running = await send(first, 'first');
    const reading = await readUntil(running.body!, (text) => text.includes('part0'));
    const started = Date.now();
    const waiting = await (await send(second, 'second')).text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(waiting).toContain('"state":"timeout"');
    expect(waiting).toContain('Stub Model is busy');
    const [failed] = await settled(second);
    expect(failed).toMatchObject({
      status: 'error',
      errorMessage: expect.stringMatching(/Stub Model is busy/),
    });
    await fetch(`${base}/api/chat/${first}/stream`, { method: 'DELETE' });
    await reading.cancel();
  }, 30_000);

  it('a draining replica hands a waiting turn back; sending it again keeps one reply', async () => {
    stub.configure({ maxConcurrent: 1, chunks: 20, chunkDelayMs: 100 });
    state.capacity = providerLimits(1);
    const first = await thread();
    const second = await thread();
    const running = await send(first, 'first');
    const reading = await readUntil(running.body!, (text) => text.includes('part0'));
    const waiting = await send(second, 'second');
    const seen = await readUntil(waiting.body!, (text) => text.includes('"state":"waiting"'));
    const drain = await import('../../lib/drain.js');
    drain.beginDrain('SIGTERM');
    const text = await seen.rest();
    expect(text).toContain('"state":"handoff"');
    const [handedBack] = await settled(second);
    expect(handedBack).toMatchObject({
      status: 'cancelled',
      errorMessage: expect.stringMatching(/restarted/),
    });
    expect(await redis.zcard(`oci:capacity:{${PROVIDER_ID}}:q`)).toBe(0);
    const prompt = handedBack!.parentMessageId!;
    expect(await redis.get(`oci:capacity:{${PROVIDER_ID}}:handoff:${prompt}`)).not.toBeNull();
    // A replica that is not draining (this one, after the drain) gets it again.
    drain.resetDrainForTests();
    await reading.cancel();
    await fetch(`${base}/api/chat/${first}/stream`, { method: 'DELETE' });
    await settled(first);
    const again = await send(second, '', people.a, {
      trigger: 'regenerate-message',
      messages: [{ id: prompt, role: 'user', parts: [{ type: 'text', text: 'second' }] }],
    });
    expect(again.status).toBe(200);
    await again.text();
    const replies = await settled(second);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: 'complete', parentMessageId: prompt });
    expect(await redis.get(`oci:capacity:{${PROVIDER_ID}}:handoff:${prompt}`)).toBeNull();
  }, 30_000);

  it('retries a 429 before the first output, honouring Retry-After, without repeating output', async () => {
    stub.configure({ refuseFirst: 1, retryAfterSeconds: 1, chunks: 3, chunkDelayMs: 20 });
    const id = await thread();
    const started = Date.now();
    const text = await (await send(id, 'retry me')).text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(stub.stats.refused).toBe(1);
    expect(text.match(/part0/g)).toHaveLength(1);
    const [reply] = await settled(id);
    expect(reply).toMatchObject({ status: 'complete' });
    const { providerRetries } = await import('../../services/observability/metrics.js');
    expect(providerRetries.get({ provider: 'Stub', model: 'stub' })).toBe(1);
  }, 30_000);

  it('a 429 pauses admissions for the time the provider asked', async () => {
    stub.configure({ refuseFirst: 1, retryAfterSeconds: 2, chunks: 2, chunkDelayMs: 20 });
    state.capacity = providerLimits(5);
    const first = await thread();
    const second = await thread();
    const one = send(first, 'one');
    // The second arrives while the provider's pause is in force.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const two = await (await send(second, 'two')).text();
    await (await one).text();
    expect(two).toContain('"state":"waiting"');
    expect((await settled(second))[0]).toMatchObject({ status: 'complete' });
    expect(stub.stats.refused).toBe(1);
  }, 30_000);
});
