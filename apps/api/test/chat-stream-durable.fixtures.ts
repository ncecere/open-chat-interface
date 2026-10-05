import {
  DefaultChatTransport,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import Redis from 'ioredis';
import { expect } from 'vitest';
import type { ChatStreamStore, resumeActiveChatRun } from '../src/services/chat-streams.js';

/**
 * Shared by the chat-stream-durable*.integration.test.ts suites: Redis
 * connection settings and probe, chat replay fixtures, and helpers that drive
 * a replay against a durable validator. Each suite declares its own mocks and
 * opens its own Redis connection.
 */

export const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
export const redisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  commandTimeout: 1_000,
  retryStrategy: () => null,
};
export const friendlyError = /^Live replay is no longer available/;
export type Identity = Parameters<ChatStreamStore['begin']>[0];
export type State = 'streaming' | 'terminal' | 'missing';
export type Validator = (signal: AbortSignal) => Promise<boolean | State>;

// Explicit contract: the pre-change implementation ignored extra JS arguments,
// yielding behavioral failures. Typed assignments below now verify this surface.
export interface DurableStore {
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
export type DurableResume = (
  threadId: string,
  userId: string,
  signal: AbortSignal | undefined,
  options: { readState: (identity: Identity, signal: AbortSignal) => Promise<State> },
) => ReturnType<typeof resumeActiveChatRun>;

export const activeKey = (identity: Identity) =>
  `oci:chat-stream:thread:${identity.threadId}:active`;
export const metadataKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:metadata`;
export const eventsKey = (identity: Identity) => `oci:chat-stream:run:${identity.runId}:events`;
export const sse = (chunk: UIMessageChunk) => `data: ${JSON.stringify(chunk)}\n\n`;
export const prefix: UIMessageChunk[] = [
  { type: 'start', messageId: 'durable-message' },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello' },
];
export const suffix: UIMessageChunk[] = [
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: 'stop' },
];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
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

export async function redisAvailable() {
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

// Decode the *actual captured wire bytes* with the browser transport, then run
// the actual UI-message reducer. Keep only concise assertions, not SDK objects.
export async function decodeWithSdk(raw: string) {
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

/** What the helpers need from a suite: its store and the state its hooks clean up. */
export interface DurableSuite {
  store: ChatStreamStore;
  durable: DurableStore;
  /** Every key a test creates, deleted after each test. */
  keys: Set<string>;
  /** Cancels each open replay after each test. */
  cleanup: Array<() => Promise<void>>;
}

export function durableHelpers({ store, durable, keys, cleanup }: DurableSuite) {
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

  return { identity, begin, append, replay, expectFriendlyWire };
}
