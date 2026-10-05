import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeKey,
  type DurableStore,
  decodeWithSdk,
  durableHelpers,
  eventsKey,
  friendlyError,
  metadataKey,
  prefix,
  redisAvailable,
  redisOptions,
  redisUrl,
  suffix,
} from '../../../test/chat-stream-durable.fixtures.js';
import { ChatStreamStore } from '../../services/chat-streams.js';

/**
 * Durable authority over real Redis chat replay.
 *
 * This file: durable admission, retries of the same run and successors.
 * The shared fixtures and replay helpers are in
 * test/chat-stream-durable.fixtures.ts; the other
 * chat-stream-durable-*.integration.test.ts files cover the rest.
 */
// Only configuration is mocked. No inference, database, Redis responses, or SDK
// parsing is mocked. The runtime test explicitly injects one transport failure.
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
    CHAT_STREAM_TTL_SECONDS: 60,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
}));

const available = await redisAvailable();

describe.skipIf(!available)('integration: durable authority over real Redis chat replay', () => {
  const redis = new Redis(redisUrl, redisOptions);
  redis.on('error', () => undefined);
  const store = new ChatStreamStore(redis, 60);
  const durable: DurableStore = store;
  const keys = new Set<string>();
  const cleanup: Array<() => Promise<void>> = [];
  const runtimeClients = new Set<Redis>();

  beforeAll(async () => {
    await redis.connect();
    expect(await redis.ping()).toBe('PONG');
  });
  afterEach(async () => {
    try {
      await Promise.all(cleanup.splice(0).map((cancel) => cancel()));
    } finally {
      vi.restoreAllMocks();
      for (const client of runtimeClients) client.disconnect();
      runtimeClients.clear();
      if (keys.size) await redis.del(...keys);
      keys.clear();
    }
  });
  afterAll(() => redis.disconnect());

  const { identity, begin, append, replay, expectFriendlyWire } = durableHelpers({
    store,
    durable,
    keys,
    cleanup,
  });

  it('keeps default admission conflict and existing real-SDK decoding as controls', async () => {
    const old = await begin();
    const next = identity(old.threadId);
    expect(await store.begin(next)).toBe('conflict');
    expect(await redis.get(activeKey(old))).toBe(old.runId);
    expect(await redis.exists(metadataKey(next))).toBe(0);

    // Exercise both SDK helper paths even before durable validation exists.
    await append(old, [...prefix, ...suffix]);
    await store.finalize(old, { status: 'complete' });
    const complete = await decodeWithSdk(await replay(old, async () => true).finish());
    expect(complete.error).toBeUndefined();
    expect(complete.chunks).toEqual([...prefix, ...suffix]);
    await redis.hset(metadataKey(old), 'replayUnavailable', '1');
    const raw = await replay(old, async () => true).finish();
    expectFriendlyWire(raw);
    const refused = await decodeWithSdk(raw);
    expect(refused.error).toBeInstanceOf(Error);
    expect((refused.error as Error).message).toMatch(friendlyError);
  });

  it('publishes a durable successor without erasing old data; old finalize/abandon cannot clear it', async () => {
    const old = await begin();
    await append(old);
    const metadata = await redis.hgetall(metadataKey(old));
    const events = await redis.xrange(eventsKey(old), '-', '+');
    const next = identity(old.threadId);
    const result = await durable.begin(next, { admission: 'durable' });
    expect.soft(result).toBe('available');
    expect(await redis.hgetall(metadataKey(old))).toEqual(metadata);
    expect(await redis.xrange(eventsKey(old), '-', '+')).toEqual(events);
    expect.soft(await redis.get(activeKey(next))).toBe(next.runId);
    await store.finalize(old, { status: 'complete' });
    expect.soft(await redis.get(activeKey(next))).toBe(next.runId);
    await store.abandon(old);
    expect.soft(await redis.get(activeKey(next))).toBe(next.runId);
    expect(await redis.xrange(eventsKey(old), '-', '+')).toEqual(events);
  });

  it('does not reset sequence, cancellation, or TTLs on a same-run durable retry', async () => {
    const value = await begin();
    await append(value);
    expect(await store.requestCancellation(value)).toBe(true);
    const tracked = [activeKey(value), metadataKey(value), eventsKey(value)];
    // A short fixture TTL makes accidental renewal to the configured 60s obvious.
    for (const key of tracked) await redis.pexpire(key, 20_000);
    const before = await Promise.all(tracked.map((key) => redis.pttl(key)));
    const metadata = await redis.hgetall(metadataKey(value));
    const events = await redis.xrange(eventsKey(value), '-', '+');
    const result = await durable.begin(value, { admission: 'durable' });
    expect(await redis.hgetall(metadataKey(value))).toEqual(metadata);
    expect(await redis.xrange(eventsKey(value), '-', '+')).toEqual(events);
    const after = await Promise.all(tracked.map((key) => redis.pttl(key)));
    for (let i = 0; i < tracked.length; i++) {
      expect(after[i]).toBeGreaterThan(0);
      expect(after[i]).toBeLessThanOrEqual(before[i]!);
    }
    expect(['available', 'unavailable']).toContain(result);
  });

  it.each([
    'missing',
    'foreign',
    'expired',
    'terminal',
    'unavailable',
    'no-index',
    'events-only',
  ] as const)('does not resurrect or reset a same-run retry with %s cache state', async (state) => {
    const value = await begin();
    await append(value);
    if (state === 'missing' || state === 'events-only') await redis.del(metadataKey(value));
    if (state === 'foreign') await redis.hset(metadataKey(value), 'runId', 'different-run');
    if (state === 'expired')
      await redis.hset(metadataKey(value), 'expiresAt', String(Date.now() - 1));
    if (state === 'terminal') await redis.hset(metadataKey(value), 'status', 'complete');
    if (state === 'unavailable') await redis.hset(metadataKey(value), 'replayUnavailable', '1');
    if (state === 'no-index' || state === 'events-only') await redis.del(activeKey(value));
    const pointer = await redis.get(activeKey(value));
    const metadata = await redis.hgetall(metadataKey(value));
    const events = await redis.xrange(eventsKey(value), '-', '+');
    expect(await durable.begin(value, { admission: 'durable' })).toBe('unavailable');
    expect(await redis.get(activeKey(value))).toBe(pointer);
    expect(await redis.hgetall(metadataKey(value))).toEqual(metadata);
    expect(await redis.xrange(eventsKey(value), '-', '+')).toEqual(events);
  });

  it('returns unavailable, never conflict or overwrite, when the observed active index changes before publication', async () => {
    const old = await begin();
    const candidate = identity(old.threadId);
    const successor = identity(old.threadId);
    // Give the racing successor valid real metadata without taking this thread's index.
    const successorThread = identity();
    expect(await store.begin({ ...successor, threadId: successorThread.threadId })).toBe(
      'available',
    );
    await redis.hset(metadataKey(successor), 'threadId', old.threadId);
    const successorMetadata = await redis.hgetall(metadataKey(successor));
    let observed = false;
    let injected = false;
    const originalGet = redis.get.bind(redis);
    const originalEval = redis.eval.bind(redis);
    vi.spyOn(redis, 'get').mockImplementation(async (...args) => {
      const result = await originalGet(...args);
      if (args[0] === activeKey(old) && result === old.runId) observed = true;
      return result;
    });
    vi.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      if (observed && !injected && args.includes(activeKey(old))) {
        injected = true;
        await redis.set(activeKey(old), successor.runId, 'EX', 60);
      }
      // The compare-and-publish Lua receives the real changed Redis state.
      return originalEval(...args);
    });
    const result = await durable.begin(candidate, { admission: 'durable' });
    expect.soft(result).toBe('unavailable');
    expect.soft(injected, 'publication must compare against the observed index').toBe(true);
    expect.soft(await originalGet(activeKey(old))).toBe(successor.runId);
    expect(await redis.hgetall(metadataKey(successor))).toEqual(successorMetadata);
  });
});
