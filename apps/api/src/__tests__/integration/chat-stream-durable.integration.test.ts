import {
  createUIMessageStreamResponse,
  DefaultChatTransport,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  beginChatRun,
  ChatStreamStore,
  captureChatRun,
  resumeActiveChatRun,
  sharedRedis,
} from '../../services/chat-streams.js';

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

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  commandTimeout: 1_000,
  retryStrategy: () => null,
};
const friendlyError = /^Live replay is no longer available/;
type Identity = Parameters<ChatStreamStore['begin']>[0];
type State = 'streaming' | 'terminal' | 'missing';
type Validator = (signal: AbortSignal) => Promise<boolean | State>;

// Explicit contract: the pre-change implementation ignored extra JS arguments,
// yielding behavioral failures. Typed assignments below now verify this surface.
interface DurableStore {
  begin(
    identity: Identity,
    options?: { admission: 'durable' },
  ): Promise<'available' | 'unavailable' | 'conflict'>;
  createReplayStream(
    identity: Identity,
    signal?: AbortSignal,
    options?: { readState: (signal: AbortSignal) => Promise<State> },
  ): ReadableStream<Uint8Array>;
}
type DurableResume = (
  threadId: string,
  userId: string,
  signal: AbortSignal | undefined,
  options: { readState: (identity: Identity, signal: AbortSignal) => Promise<State> },
) => ReturnType<typeof resumeActiveChatRun>;

const activeKey = (identity: Identity) => `oci:chat-stream:thread:${identity.threadId}:active`;
const metadataKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:metadata`;
const eventsKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:events`;
const sse = (chunk: UIMessageChunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const prefix: UIMessageChunk[] = [
  { type: 'start', messageId: 'durable-message' },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello' },
];
const suffix: UIMessageChunk[] = [
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: 'stop' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function redisAvailable() {
  const probe = new Redis(redisUrl, redisOptions);
  probe.on('error', () => undefined);
  try {
    return await bounded(
      (async () => {
        await probe.connect();
        return (await probe.ping()) === 'PONG';
      })(),
      1_500,
      'Redis availability probe timed out',
    );
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = await redisAvailable();

// Decode the *actual captured wire bytes* with the browser transport, then run
// the actual UI-message reducer. Keep only concise assertions, not SDK objects.
async function decodeWithSdk(raw: string) {
  const transport = new DefaultChatTransport({
    fetch: async () => new Response(raw, { headers: UI_MESSAGE_STREAM_HEADERS }),
  });
  const decoded = await transport.reconnectToStream({ chatId: 'fixture' });
  if (!decoded) throw new Error('Fixture HTTP 200 did not produce an SDK stream');
  const chunks: UIMessageChunk[] = [];
  const decoder = decoded.getReader();
  try {
    while (true) {
      const next = await decoder.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    await decoder.cancel().catch(() => undefined);
  }
  const messages: UIMessage[] = [];
  const reader = readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    terminateOnError: true,
  }).getReader();
  let error: unknown;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      messages.push(next.value);
    }
  } catch (caught) {
    error = caught;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { chunks, messages, error };
}

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

  function identity(threadId?: string): Identity {
    const id = `test-durable-${crypto.randomUUID()}`;
    const value = { runId: id, threadId: threadId ?? `${id}-thread`, userId: 'durable-owner' };
    for (const key of [activeKey(value), metadataKey(value), eventsKey(value)]) keys.add(key);
    return value;
  }
  async function begin() {
    const value = identity();
    expect(await store.begin(value)).toBe('available');
    return value;
  }
  async function append(value: Identity, chunks = prefix) {
    for (const chunk of chunks) await store.append(value.runId, sse(chunk));
  }

  function replay(value: Identity, validate: Validator) {
    const abort = new AbortController();
    const reader = durable
      .createReplayStream(value, abort.signal, {
        readState: async (signal) => {
          const state = await validate(signal);
          // Preserve the baseline fixture shorthand while distinguishing a lost
          // owner ('missing') from a known completed owned assistant ('terminal').
          return state === true ? 'streaming' : state === false ? 'terminal' : state;
        },
      })
      .getReader();
    const firstText = deferred<void>();
    const decoder = new TextDecoder();
    let raw = '';
    let ended = false;
    const cancel = async () => {
      // Cancel the reader as well as the request, including assertion failures.
      abort.abort();
      await reader.cancel().catch(() => undefined);
    };
    cleanup.push(cancel);
    const result = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        raw += decoder.decode(next.value, { stream: true });
        if (raw.includes('Hello')) firstText.resolve();
      }
      raw += decoder.decode();
      ended = true;
      return raw;
    })();
    // Attach immediately: failed assertions must not leave an unhandled reader rejection.
    void result.catch(() => undefined);
    return {
      reader,
      abort,
      cancel,
      firstText: firstText.promise,
      ended: () => ended,
      async finish() {
        // Successful readers are still cancelled by afterEach. Do not abort a
        // checker here: that would hide a missing timeout-driven checker abort.
        try {
          return await bounded(
            result,
            5_500,
            'Idle replay did not terminate after durable validation',
          );
        } catch (error) {
          await cancel();
          throw error;
        }
      },
    };
  }

  function expectFriendlyWire(raw: string) {
    const frames = raw.split('\n\n').filter(Boolean);
    expect(frames.at(-1)).toBe('data: [DONE]');
    const error = JSON.parse(frames.at(-2)!.slice('data: '.length));
    expect(error.type).toBe('error');
    expect(error.errorText).toMatch(friendlyError);
  }

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
