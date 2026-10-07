import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bounded,
  type DurableStore,
  decodeWithSdk,
  deferred,
  durableHelpers,
  friendlyError,
  metadataKey,
  prefix,
  redisAvailable,
  redisOptions,
  redisUrl,
  type State,
  suffix,
} from '../../../test/chat-stream-durable.fixtures.js';
import { ChatStreamStore } from '../../services/chat-streams.js';

/**
 * Durable authority over real Redis chat replay.
 *
 * This file: what an idle replay delivers once durable state is known.
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

  const { begin, append, replay, expectFriendlyWire } = durableHelpers({
    store,
    durable,
    keys,
    cleanup,
  });

  it('ends an idle cached prefix with friendly error + DONE when durable authority says terminal; the SDK finishes', async () => {
    const value = await begin();
    await append(value);
    const validate = vi.fn(async (_signal: AbortSignal) => false);
    const session = replay(value, validate);
    const raw = await session.finish();
    expect(validate).toHaveBeenCalled();
    expectFriendlyWire(raw);
    const decoded = await decodeWithSdk(raw);
    expect(decoded.error).toBeInstanceOf(Error);
    expect((decoded.error as Error).message).toMatch(friendlyError);
    expect(decoded.chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(1);
    expect(
      decoded.messages.some((message) =>
        message.parts.some((part) => part.type === 'text' && part.text === 'Hello'),
      ),
    ).toBe(true);
    expect(await store.activeRun(value.threadId, value.userId)).toEqual(value);
    expect(await store.cancellationRequested(value.runId)).toBe(false);
  }, 8_000);

  it('drains a healthy suffix that arrives while durable validation is pending', async () => {
    const value = await begin();
    await append(value);
    const entered = deferred<void>();
    const checked = deferred<boolean>();
    const session = replay(value, async (_signal) => {
      entered.resolve();
      return checked.promise;
    });
    await bounded(entered.promise, 3500, 'Validation did not begin');
    await append(value, suffix);
    await store.finalize(value, { status: 'complete' });
    checked.resolve(false);
    const decoded = await decodeWithSdk(await session.finish());
    expect(decoded.error).toBeUndefined();
    expect(decoded.chunks).toEqual([...prefix, ...suffix]);
  }, 8000);

  it('closes cleanly after a real finish frame when durable completion precedes cache finalization', async () => {
    const value = await begin();
    let captured: Promise<void> | undefined;
    const response = createUIMessageStreamResponse({
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of [...prefix, ...suffix]) controller.enqueue(chunk);
          controller.close();
        },
      }),
      consumeSseStream: ({ stream }) => {
        captured = (async () => {
          const reader = stream.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (next.value !== 'data: [DONE]\n\n') await store.append(value.runId, next.value);
            }
          } finally {
            reader.releaseLock();
          }
        })();
        return captured;
      },
    });
    await response.text();
    expect(captured).toBeDefined();
    await captured;
    expect(await redis.hget(metadataKey(value), 'lastSequence')).toBe('5');
    // Model finish is captured, but onEnd usage settlement/Redis finalization
    // has not completed. A terminal durable row must not turn success into error.
    const session = replay(value, async (_signal) => false);
    const decoded = await decodeWithSdk(await session.finish());
    expect(decoded.error).toBeUndefined();
    expect(decoded.chunks).toEqual([...prefix, ...suffix]);
    expect(await store.activeRun(value.threadId, value.userId)).toEqual(value);
    expect(await store.cancellationRequested(value.runId)).toBe(false);
  }, 8000);

  it('does not drain a newly completed suffix after durable ownership becomes missing', async () => {
    const value = await begin();
    await append(value);
    const entered = deferred<void>();
    const checked = deferred<State>();
    const session = replay(value, async (_signal) => {
      entered.resolve();
      return checked.promise;
    });
    await bounded(entered.promise, 3500, 'Validation did not begin');
    await append(value, [
      { type: 'text-delta', id: 'text-1', delta: 'Do not forward this suffix' },
      ...suffix,
    ]);
    await store.finalize(value, { status: 'complete' });
    checked.resolve('missing');
    const raw = await session.finish();
    expectFriendlyWire(raw);
    expect(raw).not.toContain('Do not forward this suffix');
    expect((await decodeWithSdk(raw)).chunks.some((chunk) => chunk.type === 'finish')).toBe(false);
  }, 8000);

  it('does not chase an indefinitely growing partial cache after durable completion', async () => {
    const value = await begin();
    await append(value);
    let terminal = false;
    const originalGet = redis.hgetall.bind(redis);
    vi.spyOn(redis, 'hgetall').mockImplementation(async (...args) => {
      const metadata = await originalGet(...args);
      if (terminal && args[0] === metadataKey(value)) {
        await append(value, [{ type: 'text-delta', id: 'text-1', delta: 'beyond snapshot' }]);
      }
      return metadata;
    });
    const session = replay(value, async (_signal) => {
      await append(value, [{ type: 'text-delta', id: 'text-1', delta: 'captured partial' }]);
      terminal = true;
      return 'terminal';
    });
    const raw = await session.finish();
    expect(raw).toContain('captured partial');
    expect(raw).not.toContain('beyond snapshot');
    expectFriendlyWire(raw);
    expect(await store.cancellationRequested(value.runId)).toBe(false);
  }, 8000);

  it('keeps a slow durable-active run open across validation intervals, then delivers its real suffix', async () => {
    const value = await begin();
    await append(value);
    const twice = deferred<void>();
    const checks: number[] = [];
    const session = replay(value, async (_signal) => {
      checks.push(performance.now());
      if (checks.length === 2) twice.resolve();
      return true;
    });
    await bounded(session.firstText, 1_500, 'Replay did not deliver its cached prefix');
    await bounded(twice.promise, 5_000, 'Idle replay never revalidated its durable-active run');
    expect(session.ended()).toBe(false);
    // The contract is a 2s query interval, not exact timer/paint scheduling.
    expect(checks[1]! - checks[0]!).toBeGreaterThanOrEqual(1_800);
    await append(value, suffix);
    await store.finalize(value, { status: 'complete' });
    const decoded = await decodeWithSdk(await session.finish());
    expect(decoded.error).toBeUndefined();
    expect(decoded.chunks).toEqual([...prefix, ...suffix]);
    expect(decoded.messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Hello',
      state: 'done',
    });
  }, 9_000);
});
