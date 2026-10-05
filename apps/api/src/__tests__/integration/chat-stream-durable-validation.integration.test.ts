import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activeKey,
  bounded,
  type DurableResume,
  type DurableStore,
  deferred,
  durableHelpers,
  eventsKey,
  type Identity,
  metadataKey,
  prefix,
  redisAvailable,
  redisOptions,
  redisUrl,
  type State,
  sse,
  suffix,
} from '../../../test/chat-stream-durable.fixtures.js';
import {
  beginChatRun,
  ChatStreamStore,
  captureChatRun,
  captureRecovery,
  resumeActiveChatRun,
  sharedRedis,
} from '../../services/chat-streams.js';

/**
 * Durable authority over real Redis chat replay.
 *
 * This file: validator failures, timeouts, cancellation and stale metadata.
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

  it('turns a thrown idle validator into a friendly reader failure without cancelling the producer', async () => {
    const value = await begin();
    await append(value);
    const validate = vi.fn(async (_signal: AbortSignal): Promise<boolean> => {
      throw new Error('private database transport details');
    });
    const raw = await replay(value, validate).finish();
    expect(validate).toHaveBeenCalled();
    expectFriendlyWire(raw);
    expect(raw).not.toContain('private database transport details');
    expect(await store.activeRun(value.threadId, value.userId)).toEqual(value);
    expect(await store.cancellationRequested(value.runId)).toBe(false);
  }, 8_000);

  it('bounds a never-resolving idle validator at 2s and aborts its checker signal', async () => {
    const value = await begin();
    await append(value);
    let checker: AbortSignal | undefined;
    let started = 0;
    let abortedAt = 0;
    const session = replay(value, (signal) => {
      checker = signal;
      started = performance.now();
      signal.addEventListener(
        'abort',
        () => {
          abortedAt = performance.now();
        },
        { once: true },
      );
      return new Promise<boolean>(() => undefined);
    });
    const raw = await session.finish();
    expectFriendlyWire(raw);
    expect(checker?.aborted).toBe(true);
    expect(abortedAt - started).toBeGreaterThanOrEqual(1_800);
    expect(abortedAt - started).toBeLessThan(2_500);
    expect(await store.cancellationRequested(value.runId)).toBe(false);
  }, 8_000);

  it.each(['reader', 'request'] as const)(
    'aborts pending validation on %s cancellation without cancelling the producer',
    async (mode) => {
      const value = await begin();
      await append(value);
      const entered = deferred<AbortSignal>();
      const session = replay(value, (signal) => {
        entered.resolve(signal);
        return new Promise<boolean>(() => undefined);
      });
      const checker = await bounded(
        entered.promise,
        3_500,
        'Idle replay never called its durable validator',
      );
      const aborted = deferred<void>();
      checker.addEventListener('abort', () => aborted.resolve(), { once: true });
      if (mode === 'reader') await session.reader.cancel();
      else session.abort.abort();
      await bounded(
        aborted.promise,
        500,
        'Reader/request cancellation did not abort pending validation',
      );
      expect(checker.aborted).toBe(true);
      expect(await store.activeRun(value.threadId, value.userId)).toEqual(value);
      expect(await store.cancellationRequested(value.runId)).toBe(false);
    },
    6_000,
  );

  it('rejects a stored runId mismatch before exposing an otherwise valid prefix', async () => {
    const value = await begin();
    await append(value, [...prefix, ...suffix]);
    await store.finalize(value, { status: 'complete' });
    await redis.hset(metadataKey(value), 'runId', `foreign-${crypto.randomUUID()}`);
    const raw = await replay(value, async () => false).finish();
    expect.soft(raw.includes('Hello'), 'mismatched metadata must not expose text').toBe(false);
    expectFriendlyWire(raw);
  });

  it('revalidates retained active metadata after injected append transport failure/cooldown; initial validator failure rejects', async () => {
    const value = identity();
    const runtime = await sharedRedis();
    expect(runtime).not.toBeNull();
    runtimeClients.add(runtime!);
    expect(await beginChatRun(value)).toBe('available');
    const originalEval = runtime!.eval.bind(runtime);
    let injected = false;
    const spy = vi.spyOn(runtime!, 'eval').mockImplementation(async (...args) => {
      if (!injected && args.includes(eventsKey(value)) && String(args[0]).includes('XADD')) {
        injected = true;
        // Explicitly injected *before* Lua, not evidence of actual packet loss.
        throw new Error('Injected transport-style append failure before Lua');
      }
      return originalEval(...args);
    });
    // The capture would otherwise wait (v0.11) for Redis to store the frames
    // it kept; this test wants the run left as the failure leaves it.
    const finalWaitMs = captureRecovery.finalWaitMs;
    captureRecovery.finalWaitMs = 0;
    await captureChatRun(
      value,
      new ReadableStream<string>({
        start(controller) {
          for (const chunk of prefix) controller.enqueue(sse(chunk));
          controller.close();
        },
      }),
      () => ({ status: 'complete' }),
    );
    captureRecovery.finalWaitMs = finalWaitMs;
    spy.mockRestore();
    expect(injected).toBe(true);
    // withStore's cooldown skips finalize, leaving a real stale-active hash.
    expect(await redis.hget(metadataKey(value), 'status')).toBe('active');
    expect(await redis.hget(metadataKey(value), 'lastSequence')).toBe('0');
    expect(await redis.get(activeKey(value))).toBe(value.runId);
    expect(await sharedRedis()).toBeNull();

    // Fixture-only clock jump bypasses 30s cooldown, without advancing Redis TTL.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    const recovered = await sharedRedis();
    expect(recovered).not.toBeNull();
    runtimeClients.add(recovered!);
    const resume: DurableResume = resumeActiveChatRun;
    const failure = new Error('Injected initial durable validation failure');
    const throws = vi.fn(async (_identity: Identity, _signal: AbortSignal): Promise<State> => {
      throw failure;
    });
    const attempted = await resume(value.threadId, value.userId, undefined, {
      readState: throws,
    }).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: null, error }),
    );
    if (attempted.result) await attempted.result.stream.cancel();
    expect.soft(throws).toHaveBeenCalled();
    expect
      .soft(
        attempted.error instanceof Error,
        'initial validation must reject, not return null/a replay',
      )
      .toBe(true);

    const terminal = vi.fn(
      async (_identity: Identity, _signal: AbortSignal) => 'terminal' as const,
    );
    const result = await resume(value.threadId, value.userId, undefined, { readState: terminal });
    if (result) await result.stream.cancel();
    expect.soft(terminal).toHaveBeenCalledWith(value, expect.any(AbortSignal));
    expect(result === null, 'terminal durable identity must be rejected before replay').toBe(true);
  }, 8_000);
});
