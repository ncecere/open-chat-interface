import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChatStreamStore,
  cancelActiveChatRun,
  registerLocalChatRun,
  sharedRedis,
  unregisterLocalChatRun,
} from '../../services/chat-streams.js';

vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
    CHAT_STREAM_TTL_SECONDS: 60,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
}));

const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const options = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  retryStrategy: () => null,
};
async function available() {
  const probe = new Redis(url, options);
  probe.on('error', () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const enabled = await available();
describe.skipIf(!enabled)('integration: atomic Redis chat cancellation', () => {
  const redis = new Redis(url, options);
  redis.on('error', () => {});
  const store = new ChatStreamStore(redis, 60);
  const keys: string[] = [];
  let runtimeClient: Redis | null = null;
  beforeAll(async () => {
    await redis.connect();
    runtimeClient = await sharedRedis();
    expect(runtimeClient).not.toBeNull();
  });
  afterEach(async () => {
    if (keys.length) await redis.del(...keys.splice(0));
  });
  afterAll(() => {
    runtimeClient?.disconnect();
    redis.disconnect();
  });

  async function fixture() {
    const id = `test-cancel-${crypto.randomUUID()}`;
    const identity = { runId: id, threadId: `${id}-thread`, userId: `${id}-owner` };
    const metadata = `oci:chat-stream:run:${id}:metadata`;
    keys.push(
      metadata,
      `oci:chat-stream:run:${id}:events`,
      `oci:chat-stream:thread:${identity.threadId}:active`,
    );
    expect(await store.begin(identity)).toBe('available');
    return { identity, metadata };
  }

  // Inject real server-side state changes immediately before the mutating
  // command. Old code has already read ownership; atomic code has not checked
  // it yet. Both HSET and EVAL are forwarded to real Redis, never mocked results.
  function beforeMutation(change: () => Promise<unknown>) {
    let injected = false;
    return new ChatStreamStore(
      new Proxy(redis, {
        get(target, property) {
          const method = Reflect.get(target, property, target);
          if (typeof method !== 'function') return method;
          return async (...args: unknown[]) => {
            if (!injected && (property === 'hset' || property === 'eval')) {
              injected = true;
              await change();
            }
            return method.apply(target, args);
          };
        },
      }),
      60,
    );
  }

  it('accepts repeated owner requests without extending the metadata TTL', async () => {
    const { identity, metadata } = await fixture();
    const before = await redis.pttl(metadata);
    expect(await store.requestCancellation(identity)).toBe(true);
    expect(await store.requestCancellation(identity)).toBe(true);
    expect(await redis.hget(metadata, 'cancelRequested')).toBe('1');
    const after = await redis.pttl(metadata);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
  });
  it('rejects another user or thread without changing cancellation state', async () => {
    const { identity, metadata } = await fixture();
    expect(await store.requestCancellation({ ...identity, userId: 'other' })).toBe(false);
    expect(await store.requestCancellation({ ...identity, threadId: 'other' })).toBe(false);
    expect(await redis.hget(metadata, 'cancelRequested')).toBeNull();
  });
  it('does not recreate metadata that expires immediately before the write', async () => {
    const { identity, metadata } = await fixture();
    const racing = beforeMutation(() => redis.pexpire(metadata, 0));
    const accepted = await racing.requestCancellation(identity);
    expect.soft(await redis.exists(metadata)).toBe(0);
    expect.soft(await redis.pttl(metadata)).not.toBe(-1);
    expect(accepted).toBe(false);
  });
  it('rechecks ownership atomically if metadata changes before the write', async () => {
    const { identity, metadata } = await fixture();
    const racing = beforeMutation(() => redis.hset(metadata, 'userId', 'replacement-owner'));
    const accepted = await racing.requestCancellation(identity);
    expect(await redis.hget(metadata, 'userId')).toBe('replacement-owner');
    expect.soft(await redis.hget(metadata, 'cancelRequested')).toBeNull();
    expect(accepted).toBe(false);
  });
  it('reports an accepted remote request only after writing the flag', async () => {
    const { identity, metadata } = await fixture();
    expect(await cancelActiveChatRun(identity.threadId, identity.userId)).toBe(true);
    expect(await redis.hget(metadata, 'cancelRequested')).toBe('1');
  });

  it('still aborts an owned local producer when its cache metadata is missing', async () => {
    const { identity, metadata } = await fixture();
    const abort = new AbortController();
    registerLocalChatRun(identity, abort);
    await redis.del(metadata);
    try {
      expect(await cancelActiveChatRun(identity.threadId, 'other-owner')).toBe(false);
      expect(abort.signal.aborted).toBe(false);
      expect(await cancelActiveChatRun(identity.threadId, identity.userId)).toBe(true);
      expect(abort.signal.aborted).toBe(true);
      expect(abort.signal.reason).toBe('user-stop');
    } finally {
      unregisterLocalChatRun(identity.runId);
    }
  });

  it('stops the newer local producer while an older completion is still settling', async () => {
    const { identity, metadata } = await fixture();
    const next = { ...identity, runId: crypto.randomUUID() };
    const oldAbort = new AbortController();
    const nextAbort = new AbortController();
    // A terminal assistant can admit a successor before the old onEnd callback
    // finishes usage settlement/unregistering. Simulate that registry overlap,
    // with no usable cache, rather than infer producer death from Redis.
    registerLocalChatRun(identity, oldAbort);
    registerLocalChatRun(next, nextAbort);
    await redis.del(metadata);
    try {
      expect(await cancelActiveChatRun(identity.threadId, identity.userId)).toBe(true);
      expect.soft(oldAbort.signal.aborted).toBe(false);
      expect(nextAbort.signal.aborted).toBe(true);
      expect(nextAbort.signal.reason).toBe('user-stop');
    } finally {
      unregisterLocalChatRun(identity.runId);
      unregisterLocalChatRun(next.runId);
    }
  });

  it('does not report remote cancellation accepted when metadata expires after lookup', async () => {
    const { identity, metadata } = await fixture();
    const original = ChatStreamStore.prototype.requestCancellation;
    const intercepted = vi
      .spyOn(ChatStreamStore.prototype, 'requestCancellation')
      .mockImplementationOnce(async function (this: ChatStreamStore, requested) {
        await redis.pexpire(metadata, 0);
        return original.call(this, requested);
      });
    try {
      expect(await cancelActiveChatRun(identity.threadId, identity.userId)).toBe(false);
      expect(intercepted).toHaveBeenCalledOnce();
      expect(await redis.exists(metadata)).toBe(0);
    } finally {
      intercepted.mockRestore();
    }
  });

  it('rejects a logically expired cache entry without mutating it', async () => {
    const { identity, metadata } = await fixture();
    await redis.hset(metadata, 'expiresAt', String(Date.now() - 1));
    expect(await store.requestCancellation(identity)).toBe(false);
    expect(await redis.hget(metadata, 'cancelRequested')).toBeNull();
  });
  it('rejects non-expiring metadata instead of writing an unbounded marker', async () => {
    const { identity, metadata } = await fixture();
    await redis.persist(metadata);
    expect(await store.requestCancellation(identity)).toBe(false);
    expect(await redis.hget(metadata, 'cancelRequested')).toBeNull();
  });
  it('does not request cancellation of a retained terminal run', async () => {
    const { identity, metadata } = await fixture();
    await store.finalize(identity, { status: 'complete' });
    expect(await store.requestCancellation(identity)).toBe(false);
    expect(await redis.hget(metadata, 'cancelRequested')).toBeNull();
  });
});
