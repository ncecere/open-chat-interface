import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatStreamStore } from '../../services/chat-streams.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';

/**
 * Redis is optional, so this suite skips rather than fails when it is absent.
 * Otherwise a machine or CI job without Redis reports a false failure.
 */
async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
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

const available = await redisAvailable();

describe.skipIf(!available)('integration: Redis resumable chat streams', () => {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const store = new ChatStreamStore(redis, 60);

  beforeAll(async () => {
    await redis.connect();
    await redis.ping();
  });

  afterAll(async () => {
    const keys = await redis.keys('oci:chat-stream:*test-*');
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('enforces ownership, rejects a second active run, and replays SSE in order', async () => {
    const identity = {
      runId: `test-${crypto.randomUUID()}`,
      threadId: `test-thread-${crypto.randomUUID()}`,
      userId: 'owner-1',
    };
    await expect(store.begin(identity)).resolves.toBe('available');
    await expect(store.begin({ ...identity, runId: `test-${crypto.randomUUID()}` })).resolves.toBe(
      'conflict',
    );
    await expect(store.activeRun(identity.threadId, 'other-owner')).resolves.toBeNull();
    await expect(store.activeRun(identity.threadId, identity.userId)).resolves.toEqual(identity);

    await store.append(identity.runId, 'data: {"type":"start"}\n\n');
    await store.append(
      identity.runId,
      'data: {"type":"text-delta","id":"text-1","delta":"hello"}\n\n',
    );

    const replay = store.createReplayStream(identity);
    const replayText = new Response(replay).text();
    await store.finalize(identity, { status: 'complete' });

    await expect(replayText).resolves.toBe(
      'data: {"type":"start"}\n\ndata: {"type":"text-delta","id":"text-1","delta":"hello"}\n\n',
    );
    await expect(store.activeRun(identity.threadId, identity.userId)).resolves.toBeNull();

    const keys = await redis.keys(`oci:chat-stream:*${identity.runId}*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });

  it('records an owner-scoped cancellation request', async () => {
    const identity = {
      runId: `test-${crypto.randomUUID()}`,
      threadId: `test-thread-${crypto.randomUUID()}`,
      userId: 'owner-2',
    };
    await store.begin(identity);
    await expect(store.requestCancellation({ ...identity, userId: 'other-owner' })).resolves.toBe(
      false,
    );
    await expect(store.requestCancellation(identity)).resolves.toBe(true);
    await expect(store.cancellationRequested(identity.runId)).resolves.toBe(true);
    await store.finalize(identity, { status: 'cancelled' });
  });
});
