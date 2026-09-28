import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createChatReplay } from './chat-stream-replay.js';

const KEY_PREFIX = 'oci:chat-stream';
const MAX_EVENTS = 10_000;
const REDIS_RETRY_DELAY_MS = 30_000;

export type ChatRunStatus = 'active' | 'complete' | 'error' | 'cancelled';

interface ChatRunIdentity {
  runId: string;
  threadId: string;
  userId: string;
}

interface ChatRunOutcome {
  status: Exclude<ChatRunStatus, 'active'>;
  error?: string;
  replayUnavailable?: boolean;
}

export type BeginChatRunResult = 'available' | 'unavailable' | 'conflict';

function activeKey(threadId: string) {
  return `${KEY_PREFIX}:thread:${threadId}:active`;
}

function metadataKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:metadata`;
}

function eventsKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:events`;
}

/** Redis persistence for one bounded, owner-scoped AI SDK SSE stream. */
export class ChatStreamStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async begin(identity: ChatRunIdentity): Promise<'available' | 'conflict'> {
    const active = activeKey(identity.threadId);
    const acquired = await this.redis.set(active, identity.runId, 'EX', this.ttlSeconds, 'NX');
    if (acquired !== 'OK') return 'conflict';

    try {
      const replies = await this.redis
        .multi()
        .hset(metadataKey(identity.runId), {
          runId: identity.runId,
          threadId: identity.threadId,
          userId: identity.userId,
          status: 'active',
          replayVersion: '1',
          lastSequence: '0',
          replayUnavailable: '0',
          expiresAt: String(Date.now() + this.ttlSeconds * 1000),
        })
        .expire(metadataKey(identity.runId), this.ttlSeconds)
        .exec();
      if (!replies || replies.some(([error]) => error))
        throw new Error('Could not initialize chat stream metadata');
      return 'available';
    } catch (error) {
      await this.redis
        .eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
          1,
          active,
          identity.runId,
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async abandon(identity: ChatRunIdentity): Promise<void> {
    await this.finalize(identity, {
      status: 'error',
      error: 'Stream setup failed',
      replayUnavailable: true,
    });
  }

  async requestCancellation(identity: ChatRunIdentity): Promise<boolean> {
    const metadata = await this.redis.hgetall(metadataKey(identity.runId));
    if (metadata.threadId !== identity.threadId || metadata.userId !== identity.userId)
      return false;

    await this.redis.hset(metadataKey(identity.runId), 'cancelRequested', '1');
    return true;
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    return (await this.redis.hget(metadataKey(runId), 'cancelRequested')) === '1';
  }

  async append(runId: string, value: string): Promise<void> {
    // One operation: metadata cannot expire between validation and XADD, and
    // sequence gaps remain detectable even when MAXLEN drops the SSE prefix.
    // Increment before XADD: if the latter fails, replay sees a missing event
    // rather than mistaking a partial cache for successful completion.
    await this.redis.eval(
      `
      local expires = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
      local ttl = redis.call('PTTL', KEYS[1])
      if not expires or expires <= tonumber(ARGV[1]) or ttl <= 0 then
        return redis.error_reply('Chat stream metadata expired')
      end
      if redis.call('HGET', KEYS[1], 'status') ~= 'active'
        or redis.call('HGET', KEYS[1], 'replayVersion') ~= '1' then
        return redis.error_reply('Chat stream is not accepting events')
      end
      local seq = redis.call('HINCRBY', KEYS[1], 'lastSequence', 1)
      local appended = redis.pcall('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'seq', tostring(seq), 'data', ARGV[3])
      if type(appended) == 'table' and appended.err then
        redis.call('HSET', KEYS[1], 'replayUnavailable', '1')
        return redis.error_reply(appended.err)
      end
      redis.call('PEXPIRE', KEYS[2], ttl)
      return seq
    `,
      2,
      metadataKey(runId),
      eventsKey(runId),
      Date.now(),
      MAX_EVENTS,
      value,
    );
  }

  async finalize(identity: ChatRunIdentity, outcome: ChatRunOutcome): Promise<void> {
    // Ownership check and deletion must be one operation: an expired active
    // key can be replaced between a client-side GET and a subsequent DEL.
    await this.redis.eval(
      `
      if redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[1]
        or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2] then return 0 end
      redis.call('HSET', KEYS[1], 'status', ARGV[4])
      if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
      if ARGV[6] == '1' then redis.call('HSET', KEYS[1], 'replayUnavailable', '1') end
      if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
      return 1
    `,
      2,
      metadataKey(identity.runId),
      activeKey(identity.threadId),
      identity.threadId,
      identity.userId,
      identity.runId,
      outcome.status,
      outcome.error?.slice(0, 500) ?? '',
      outcome.replayUnavailable ? '1' : '0',
    );
  }

  async activeRun(threadId: string, userId: string): Promise<ChatRunIdentity | null> {
    const runId = await this.redis.get(activeKey(threadId));
    if (!runId) return null;

    const metadata = await this.redis.hgetall(metadataKey(runId));
    if (
      metadata.status !== 'active' ||
      metadata.threadId !== threadId ||
      metadata.userId !== userId
    ) {
      return null;
    }

    return { runId, threadId, userId };
  }

  /** Replays from the beginning, then tails until the producer finalizes. */
  createReplayStream(identity: ChatRunIdentity, signal?: AbortSignal): ReadableStream<Uint8Array> {
    return createChatReplay({
      redis: this.redis,
      identity,
      metadataKey: metadataKey(identity.runId),
      eventsKey: eventsKey(identity.runId),
      signal,
    });
  }
}

let runtimeStore: ChatStreamStore | null = null;
let redisClient: Redis | null = null;
let redisUnavailableUntil = 0;

async function runtimeChatStreamStore(): Promise<ChatStreamStore | null> {
  const env = loadEnv();
  if (!env.REDIS_URL || Date.now() < redisUnavailableUntil) return null;
  if (runtimeStore) return runtimeStore;

  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();
    redisClient = client;
    runtimeStore = new ChatStreamStore(client, env.CHAT_STREAM_TTL_SECONDS);
    return runtimeStore;
  } catch (error) {
    redisUnavailableUntil = Date.now() + REDIS_RETRY_DELAY_MS;
    client.disconnect();
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis connection failed' },
      'Resumable chat streams unavailable',
    );
    return null;
  }
}

/**
 * The shared Redis connection, or null when Redis is unconfigured or down.
 *
 * Rate limiting and concurrency caps reuse this rather than opening a second
 * connection: they need the same availability signal, and a limiter that
 * silently used a different client could disagree about whether Redis works.
 */
export async function sharedRedis(): Promise<Redis | null> {
  await runtimeChatStreamStore();
  return redisClient;
}

async function withStore<T>(operation: (store: ChatStreamStore) => Promise<T>): Promise<T | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    return await operation(store);
  } catch (error) {
    redisUnavailableUntil = Date.now() + REDIS_RETRY_DELAY_MS;
    runtimeStore = null;
    redisClient?.disconnect();
    redisClient = null;
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Resumable chat stream persistence failed',
    );
    return null;
  }
}

const localRuns = new Map<string, { identity: ChatRunIdentity; abort: AbortController }>();

/**
 * Reports whether resumable streams are actually working, reusing the shared
 * connection rather than opening a second one. `disabled` means no REDIS_URL is
 * configured; `error` means one is configured but unreachable, which is worth
 * surfacing because streams silently fall back to non-resumable.
 */
export async function chatStreamRedisStatus(): Promise<'ok' | 'error' | 'disabled'> {
  if (!loadEnv().REDIS_URL) return 'disabled';
  return (await runtimeChatStreamStore()) ? 'ok' : 'error';
}

export async function beginChatRun(identity: ChatRunIdentity): Promise<BeginChatRunResult> {
  const result = await withStore((store) => store.begin(identity));
  return result ?? 'unavailable';
}

export async function abandonChatRun(identity: ChatRunIdentity): Promise<void> {
  await withStore((store) => store.abandon(identity));
}

export function registerLocalChatRun(identity: ChatRunIdentity, abort: AbortController): void {
  localRuns.set(identity.runId, { identity, abort });
}

export function unregisterLocalChatRun(runId: string): void {
  localRuns.delete(runId);
}

export async function isChatRunCancellationRequested(runId: string): Promise<boolean> {
  return (await withStore((store) => store.cancellationRequested(runId))) ?? false;
}

export async function cancelActiveChatRun(threadId: string, userId: string): Promise<boolean> {
  const local = [...localRuns.values()].find(
    (run) => run.identity.threadId === threadId && run.identity.userId === userId,
  );
  if (local) local.abort.abort('user-stop');

  const active = await withStore((store) => store.activeRun(threadId, userId));
  if (active) await withStore((store) => store.requestCancellation(active));
  return Boolean(local || active);
}

export async function resumeActiveChatRun(
  threadId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; persistence: 'redis'; runId: string } | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    const identity = await store.activeRun(threadId, userId);
    if (!identity) return null;
    return {
      stream: store.createReplayStream(identity, signal),
      persistence: 'redis',
      runId: identity.runId,
    };
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Could not resume chat stream',
    );
    return null;
  }
}

export async function captureChatRun(
  identity: ChatRunIdentity,
  stream: ReadableStream<string>,
  getOutcome: () => ChatRunOutcome,
): Promise<void> {
  const reader = stream.getReader();
  let persistenceFailed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (persistenceFailed) continue;

      const stored = await withStore(async (store) => {
        await store.append(identity.runId, value);
        return true;
      });
      if (!stored) persistenceFailed = true;
    }
  } catch (error) {
    persistenceFailed = true;
    logger.warn(
      {
        err: error instanceof Error ? error.message : 'Stream capture failed',
        runId: identity.runId,
      },
      'Chat stream capture failed',
    );
  } finally {
    reader.releaseLock();
    const outcome = persistenceFailed
      ? { status: 'error' as const, error: 'Stream persistence failed', replayUnavailable: true }
      : getOutcome();
    await withStore((store) => store.finalize(identity, outcome));
    unregisterLocalChatRun(identity.runId);
  }
}
