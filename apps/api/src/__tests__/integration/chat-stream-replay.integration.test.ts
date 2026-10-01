import {
  DefaultChatTransport,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatStreamStore } from '../../services/chat-streams.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const namespace = `test-replay-${crypto.randomUUID()}`;
const friendlyError = /^Live replay is no longer available/;

// Like chat-streams.integration.test.ts, Redis is optional, never mocked.
async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined);
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
type Identity = Parameters<ChatStreamStore['begin']>[0];
type Row = [string, string[]];
const eventsKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:events`;
const metadataKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:metadata`;
const sse = (chunk: UIMessageChunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const textPrefix: UIMessageChunk[] = [
  { type: 'start', messageId: 'message-1' },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello' },
];
const textSuffix: UIMessageChunk[] = [
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: 'stop' },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!available)('integration: Redis replay through the real AI SDK', () => {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const store = new ChatStreamStore(redis, 60);
  const identities: Identity[] = [];
  const replayCleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await redis.connect();
    await redis.ping();
  });

  afterEach(async () => {
    await Promise.all(replayCleanup.splice(0).map((cancel) => cancel()));
    vi.restoreAllMocks();
    // Even failed assertions must not leave active producer fixtures behind.
    for (const identity of identities.splice(0)) {
      await store.finalize(identity, { status: 'complete' });
    }
  });

  afterAll(async () => {
    const keys = await redis.keys(`oci:chat-stream:*${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  async function begin(): Promise<Identity> {
    const identity = {
      runId: `${namespace}-${crypto.randomUUID()}`,
      threadId: `${namespace}-thread-${crypto.randomUUID()}`,
      userId: 'replay-owner',
    };
    identities.push(identity);
    expect(await store.begin(identity)).toBe('available');
    return identity;
  }

  async function append(identity: Identity, chunks: UIMessageChunk[]) {
    for (const chunk of chunks) await store.append(identity.runId, sse(chunk));
  }

  async function replay(identity: Identity) {
    const abort = new AbortController();
    const chunks: UIMessageChunk[] = [];
    const messages: UIMessage[] = [];
    // Only HTTP is injected. SSE decoding, chunk validation, and message-state
    // reconstruction all use the SDK used by the actual browser transport.
    const transport = new DefaultChatTransport({
      fetch: async () =>
        new Response(store.createReplayStream(identity, abort.signal), {
          headers: UI_MESSAGE_STREAM_HEADERS,
        }),
    });
    const stream = await transport.reconnectToStream({ chatId: identity.threadId });
    if (!stream) throw new Error('Replay test helper: injected HTTP 200 returned no stream');
    const reader = stream.getReader();
    const cancel = async () => {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    };
    replayCleanup.push(cancel);
    const observed = new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        const item = await reader.read();
        if (item.done) controller.close();
        else {
          chunks.push(item.value);
          controller.enqueue(item.value);
        }
      },
      cancel,
    });
    let timedOut = false;
    // A watchdog, not a synchronization sleep: failures cannot leave a live
    // tail or the SDK's internal consumer running past the test.
    const watchdog = setTimeout(() => {
      timedOut = true;
      void cancel();
    }, 5_000);
    const result = (async () => {
      let error: unknown;
      try {
        for await (const message of readUIMessageStream({
          stream: observed,
          terminateOnError: true,
        }))
          messages.push(message);
      } catch (caught) {
        error = caught;
      } finally {
        clearTimeout(watchdog);
        await cancel();
      }
      if (timedOut) throw new Error('Replay test helper watchdog: replay did not terminate');
      return { chunks, messages, error };
    })();
    return { result, cancel };
  }

  function expectFriendlyFailure(
    result: Awaited<Awaited<ReturnType<typeof replay>>['result']>,
    initial = true,
  ) {
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(friendlyError);
    expect(result.chunks).toContainEqual({
      type: 'error',
      errorText: expect.stringMatching(friendlyError),
    });
    if (initial) {
      expect(result.messages).toEqual([]);
      expect(
        result.chunks.some(
          (chunk) => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta',
        ),
      ).toBe(false);
    }
  }

  it('roundtrips complete text, reasoning, and context-window data with the SDK', async () => {
    const identity = await begin();
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'message-1' },
      { type: 'reasoning-start', id: 'reasoning-1' },
      { type: 'reasoning-delta', id: 'reasoning-1', delta: 'Think first.' },
      { type: 'reasoning-end', id: 'reasoning-1' },
      { type: 'data-context-window', data: { limited: true } },
      ...textPrefix.slice(1),
      { type: 'text-delta', id: 'text-1', delta: ' world' },
      ...textSuffix,
    ];
    await append(identity, chunks);
    await store.finalize(identity, { status: 'complete' });

    const result = await (await replay(identity)).result;
    expect(result.error).toBeUndefined();
    expect(result.chunks).toEqual(chunks);
    expect(result.messages.at(-1)).toMatchObject({
      id: 'message-1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Think first.', state: 'done' },
        { type: 'data-context-window', data: { limited: true } },
        { type: 'text', text: 'Hello world', state: 'done' },
      ],
    });
  });

  it('rejects a naturally trimmed >10,000-record replay before orphan deltas reach the SDK', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    await Promise.all(
      Array.from({ length: 10_300 }, () =>
        store.append(identity.runId, sse({ type: 'text-delta', id: 'text-1', delta: 'x' })),
      ),
    );
    await append(identity, textSuffix);
    await store.finalize(identity, { status: 'complete' });
    // Confirm natural MAXLEN trimming happened without assuming its exact size.
    expect(await redis.xlen(eventsKey(identity))).toBeLessThan(10_305);
    expectFriendlyFailure(await (await replay(identity)).result);
  }, 10_000);

  it('rejects a forcibly removed prefix without cancelling the active producer', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    const rows = (await redis.xrange(eventsKey(identity), '-', '+')) as Row[];
    await redis.xdel(eventsKey(identity), ...rows.slice(0, 2).map(([id]) => id));

    const result = await (await replay(identity)).result;
    expect(await store.activeRun(identity.threadId, identity.userId)).toEqual(identity);
    // Replay failure is independent of the backend's continuing capture.
    await append(identity, textSuffix);
    await store.finalize(identity, { status: 'complete' });
    expectFriendlyFailure(result);
  }, 10_000);

  it('detects a deterministic unread gap while tailing, preserving only the valid prefix', async () => {
    const identity = await begin();
    await append(identity, [...textPrefix, { type: 'text-end', id: 'text-1' }]);
    const reachedSecondRead = deferred();
    const releaseSecondRead = deferred();
    const originalXrange = redis.xrange.bind(redis);
    let calls = 0;
    let lastReadId = '0-0';
    const spy = vi.spyOn(redis, 'xrange').mockImplementation(async (...args) => {
      if (args[0] === eventsKey(identity)) {
        calls += 1;
        if (calls === 2) {
          reachedSecondRead.resolve();
          await releaseSecondRead.promise;
        }
      }
      const rows = await originalXrange(...args);
      if (args[0] === eventsKey(identity) && calls === 1 && rows.length > 0) {
        lastReadId = rows.at(-1)![0];
      }
      return rows;
    });
    const session = await replay(identity);
    try {
      await Promise.race([
        reachedSecondRead.promise,
        session.result.then(() => {
          throw new Error('Replay ended before the tailing gate');
        }),
      ]);
      await append(identity, [
        { type: 'text-start', id: 'text-2' },
        { type: 'text-delta', id: 'text-2', delta: 'must not leak' },
        { type: 'text-end', id: 'text-2' },
      ]);
      const unread = await originalXrange(eventsKey(identity), `(${lastReadId}`, '+');
      expect(unread.length).toBeGreaterThan(1);
      await redis.xdel(eventsKey(identity), unread[0]![0]);
      releaseSecondRead.resolve();
      const result = await session.result;
      expect(await store.activeRun(identity.threadId, identity.userId)).toEqual(identity);
      await append(identity, [{ type: 'finish', finishReason: 'stop' }]);
      await store.finalize(identity, { status: 'complete' });
      expectFriendlyFailure(result, false);
      expect(
        result.messages.some((message) =>
          message.parts.some((part) => part.type === 'text' && part.text === 'Hello'),
        ),
      ).toBe(true);
      expect(
        result.chunks.some((chunk) => chunk.type === 'text-delta' && chunk.id === 'text-2'),
      ).toBe(false);
    } finally {
      releaseSecondRead.resolve();
      await session.cancel();
      spy.mockRestore();
    }
  }, 10_000);

  it('waits through an idle tail and then delivers a complete contiguous reply', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    const idle = deferred();
    const original = redis.xrange.bind(redis);
    vi.spyOn(redis, 'xrange').mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (args[0] === eventsKey(identity) && !rows.length) idle.resolve();
      return rows;
    });
    const session = await replay(identity);
    await Promise.race([
      idle.promise,
      session.result.then(() => {
        throw new Error('Replay ended before idle tail');
      }),
    ]);
    const ending: UIMessageChunk[] = [
      { type: 'text-delta', id: 'text-1', delta: ' again' },
      ...textSuffix,
    ];
    await append(identity, ending);
    await store.finalize(identity, { status: 'complete' });
    const result = await session.result;
    expect(result.error).toBeUndefined();
    expect(result.chunks).toEqual([...textPrefix, ...ending]);
    expect(result.messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Hello again',
      state: 'done',
    });
  });

  it('fails explicitly when metadata expires instead of silently returning an empty replay', async () => {
    const identity = await begin();
    await append(identity, [...textPrefix, ...textSuffix]);
    await store.finalize(identity, { status: 'complete' });
    await redis.pexpireat(metadataKey(identity), 1);
    expect(await redis.exists(metadataKey(identity))).toBe(0);
    expectFriendlyFailure(await (await replay(identity)).result);
  });

  it('fails explicitly when the event stream is lost but metadata says records were appended', async () => {
    const identity = await begin();
    await append(identity, [...textPrefix, ...textSuffix]);
    await store.finalize(identity, { status: 'complete' });
    await redis.del(eventsKey(identity));
    expectFriendlyFailure(await (await replay(identity)).result);
  });

  it('never exposes owner data to a foreign owner', async () => {
    const identity = await begin();
    await append(identity, [...textPrefix, ...textSuffix]);
    await store.finalize(identity, { status: 'complete' });
    expect(await store.activeRun(identity.threadId, 'foreign-owner')).toBeNull();
    const result = await (await replay({ ...identity, userId: 'foreign-owner' })).result;
    expect(result.messages).toEqual([]);
    // Either empty denial or a generic protocol error is safe; no stored chunk is.
    expect(result.chunks.every((chunk) => chunk.type === 'error')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Hello');
  });

  it('fails safely for legacy metadata without replayVersion=1', async () => {
    const identity = await begin();
    await append(identity, [...textPrefix, ...textSuffix]);
    await store.finalize(identity, { status: 'complete' });
    await redis.hdel(metadataKey(identity), 'replayVersion', 'lastSequence');
    expectFriendlyFailure(await (await replay(identity)).result);
  });

  it('refuses a failed capture even when its cached prefix has no sequence hole', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    await store.finalize(identity, {
      status: 'error',
      error: 'Stream persistence failed',
      replayUnavailable: true,
    });
    expectFriendlyFailure(await (await replay(identity)).result);
  });

  it('fetches another batch only when reader demand consumes its bounded buffer', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    await Promise.all(
      Array.from({ length: 450 }, () =>
        store.append(identity.runId, sse({ type: 'text-delta', id: 'text-1', delta: 'x' })),
      ),
    );
    await append(identity, textSuffix);
    await store.finalize(identity, { status: 'complete' });
    const reads = vi.spyOn(redis, 'xrange');
    const reader = store.createReplayStream(identity).getReader();
    replayCleanup.push(async () => {
      await reader.cancel();
    });
    for (let i = 0; i < 199; i++) expect((await reader.read()).done).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    expect(reads).toHaveBeenCalledTimes(2);
    await reader.cancel();
  });

  it('rejects Redis command errors when the events key has the wrong type', async () => {
    const identity = await begin();
    await redis.set(eventsKey(identity), 'wrong-type');
    await expect(store.append(identity.runId, sse(textPrefix[0]!))).rejects.toThrow();
    expect(await store.activeRun(identity.threadId, identity.userId)).toEqual(identity);
    expect(await redis.get(eventsKey(identity))).toBe('wrong-type');
    expect(await redis.hget(metadataKey(identity), 'replayUnavailable')).toBe('1');
    expectFriendlyFailure(await (await replay(identity)).result);
  });

  it('rejects appends after metadata expiry without resurrecting event keys', async () => {
    const identity = await begin();
    await append(identity, textPrefix);
    await redis.pexpireat(metadataKey(identity), 1);
    await redis.pexpireat(eventsKey(identity), 1);
    expect(await redis.exists(metadataKey(identity), eventsKey(identity))).toBe(0);
    // Collect the outcome before assertions so a regression still checks the
    // stronger invariant: failed appends must not recreate an event stream.
    const error = await store.append(identity.runId, sse(textSuffix[0]!)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(await redis.exists(eventsKey(identity))).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect(await redis.exists(metadataKey(identity))).toBe(0);
  });
});
