import {
  DefaultChatTransport,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReplaySnapshot } from '../../services/chat-stream-snapshot.js';
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

  async function replay(identity: Identity, from: ChatStreamStore = store) {
    const abort = new AbortController();
    const chunks: UIMessageChunk[] = [];
    const messages: UIMessage[] = [];
    // Only HTTP is injected. SSE decoding, chunk validation, and message-state
    // reconstruction all use the SDK used by the actual browser transport.
    const transport = new DefaultChatTransport({
      fetch: async () =>
        new Response(from.createReplayStream(identity, abort.signal), {
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

  describe('a very long artifact after a reload (v0.10)', () => {
    // Keep 40 events instead of 10,000: a snapshot every 10.
    const small = new ChatStreamStore(redis, 60, { maxEvents: 40 });
    const content = Array.from({ length: 300 }, (_, line) => `<p>line ${line}</p>`).join('\n');
    const input = JSON.stringify({ title: 'Long page', kind: 'html', content });
    // The tool input arrives in small pieces, as a model writes it.
    const pieces = input.match(/[\s\S]{1,8}/g)!;
    const opening: UIMessageChunk[] = [
      { type: 'start', messageId: 'message-1' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Here ' },
      { type: 'text-delta', id: 'text-1', delta: 'it is.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'create_artifact' },
    ];
    const deltas: UIMessageChunk[] = pieces.map((inputTextDelta) => ({
      type: 'tool-input-delta',
      toolCallId: 'call-1',
      inputTextDelta,
    }));
    const closing: UIMessageChunk[] = [
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'create_artifact',
        input: JSON.parse(input),
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-1',
        output: { artifactId: 'artifact-1', version: 1 },
      },
      { type: 'finish-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Done.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish', finishReason: 'stop' },
    ];
    // The reload happens 20 pieces before the end: what follows (27 events)
    // fits in the 40 kept, as the 10,000 kept in production outlast any
    // reader. (A reader that falls more than the limit behind still fails.)
    const half = deltas.length - 20;

    async function beginSmall(): Promise<Identity> {
      const identity = {
        runId: `${namespace}-${crypto.randomUUID()}`,
        threadId: `${namespace}-thread-${crypto.randomUUID()}`,
        userId: 'replay-owner',
      };
      identities.push(identity);
      expect(await small.begin(identity)).toBe('available');
      return identity;
    }

    async function firstKeptSequence(identity: Identity): Promise<number> {
      const [first] = (await redis.xrange(eventsKey(identity), '-', '+', 'COUNT', 1)) as Row[];
      return Number(first![1][first![1].indexOf('seq') + 1]);
    }

    it('fails without a snapshot once the oldest events are trimmed (the v0.9 defect)', async () => {
      const identity = await beginSmall();
      for (const chunk of [...opening, ...deltas.slice(0, half)])
        await small.append(identity.runId, sse(chunk));
      expect(await firstKeptSequence(identity)).toBeGreaterThan(1);
      const session = await replay(identity, small);
      for (const chunk of [...deltas.slice(half), ...closing])
        await small.append(identity.runId, sse(chunk));
      await small.finalize(identity, { status: 'complete' });
      expectFriendlyFailure(await session.result);
    }, 10_000);

    it('reloading mid-artifact starts from the saved draft and continues with live events', async () => {
      const identity = await beginSmall();
      const snapshot = new ReplaySnapshot();
      for (const chunk of [...opening, ...deltas.slice(0, half)])
        await small.append(identity.runId, sse(chunk), snapshot);
      // More than the limit was streamed: the start of the reply is gone.
      expect(deltas.length).toBeGreaterThan(40 * 10);
      expect(await firstKeptSequence(identity)).toBeGreaterThan(opening.length + 1);

      // The reload: a replay starting while the artifact is still being written.
      const session = await replay(identity, small);
      for (const chunk of [...deltas.slice(half), ...closing])
        await small.append(identity.runId, sse(chunk), snapshot);
      await small.finalize(identity, { status: 'complete' });
      const result = await session.result;
      expect(result.error).toBeUndefined();

      // The draft arrived as one delta carrying the input written so far,
      // then the live deltas followed, so far fewer chunks than events.
      const toolDeltas = result.chunks.filter((chunk) => chunk.type === 'tool-input-delta');
      expect(toolDeltas[0]?.inputTextDelta.length).toBeGreaterThan(400);
      expect(toolDeltas.map((chunk) => chunk.inputTextDelta).join('')).toBe(input);
      expect(result.chunks.length).toBeLessThan(opening.length + deltas.length);
      expect(result.chunks.slice(0, 3)).toEqual([
        { type: 'start', messageId: 'message-1' },
        { type: 'start-step' },
        { type: 'text-start', id: 'text-1' },
      ]);

      // The same message as replaying every event.
      expect(result.messages.at(-1)).toMatchObject({
        id: 'message-1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'Here it is.', state: 'done' },
          {
            type: 'tool-create_artifact',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { title: 'Long page', kind: 'html', content },
            output: { artifactId: 'artifact-1', version: 1 },
          },
          { type: 'text', text: 'Done.', state: 'done' },
        ],
      });
      // While it was still being written, the reader saw a partial draft.
      const drafts = result.messages
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.type === 'tool-create_artifact' &&
            'state' in part &&
            part.state === 'input-streaming',
        );
      expect(drafts.length).toBeGreaterThan(0);
    }, 10_000);

    it('replays a finished long reply from its snapshot too', async () => {
      const identity = await beginSmall();
      const snapshot = new ReplaySnapshot();
      for (const chunk of [...opening, ...deltas, ...closing])
        await small.append(identity.runId, sse(chunk), snapshot);
      await small.finalize(identity, { status: 'complete' });
      const result = await (await replay(identity, small)).result;
      expect(result.error).toBeUndefined();
      expect(result.messages.at(-1)?.parts.at(-1)).toMatchObject({ type: 'text', text: 'Done.' });
    }, 10_000);

    it('refuses a snapshot that no longer reaches the oldest kept event', async () => {
      const identity = await beginSmall();
      const snapshot = new ReplaySnapshot();
      for (const chunk of [...opening, ...deltas.slice(0, half)])
        await small.append(identity.runId, sse(chunk), snapshot);
      const key = `oci:chat-stream:run:${identity.runId}:snapshot`;
      await redis.set(
        key,
        JSON.stringify({ sequence: 2, frames: [sse(opening[0]!), sse(opening[1]!)] }),
      );
      const session = await replay(identity, small);
      await small.finalize(identity, { status: 'complete' });
      expectFriendlyFailure(await session.result);
      // A malformed one too.
      await redis.set(key, '{"sequence":"x"}');
      expectFriendlyFailure(await (await replay(identity, small)).result);
    }, 10_000);
  });

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
