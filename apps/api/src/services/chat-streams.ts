import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { OwnedRunState } from './chat/run-state.js';
import { type ReplayValidator, validateReplayRun } from './chat-replay-validation.js';
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

/** Only a caller that has already acquired the durable assistant claim may use this. */
interface BeginOptions {
  admission: 'durable';
}

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

  async begin(identity: ChatRunIdentity, options?: BeginOptions): Promise<BeginChatRunResult> {
    if (options?.admission === 'durable') return this.publishAdmitted(identity);
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

  private async publishAdmitted(identity: ChatRunIdentity): Promise<'available' | 'unavailable'> {
    const active = activeKey(identity.threadId);
    const observed = await this.redis.get(active);
    // PostgreSQL has already admitted this run. Redis is only a cache, but a
    // delayed publication must still compare-and-swap rather than overwrite an
    // index that changed after observation. Never erase another run's data or
    // reset this run's existing prefix, cancellation flag, or expiry on retry.
    const published = await this.redis.eval(
      `
      local current = redis.call('GET', KEYS[1]) or ''
      if current ~= ARGV[1] then return 0 end
      if current == ARGV[2] then
        local expires = tonumber(redis.call('HGET', KEYS[2], 'expiresAt'))
        if redis.call('HGET', KEYS[2], 'runId') == ARGV[2]
          and redis.call('HGET', KEYS[2], 'threadId') == ARGV[3]
          and redis.call('HGET', KEYS[2], 'userId') == ARGV[4]
          and redis.call('HGET', KEYS[2], 'status') == 'active'
          and redis.call('HGET', KEYS[2], 'replayVersion') == '1'
          and redis.call('HGET', KEYS[2], 'replayUnavailable') == '0'
          and expires and expires > tonumber(ARGV[7])
          and redis.call('PTTL', KEYS[1]) > 0
          and redis.call('PTTL', KEYS[2]) > 0 then return 1 end
        return 0
      end
      if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
      redis.call('HSET', KEYS[2],
        'runId', ARGV[2], 'threadId', ARGV[3], 'userId', ARGV[4],
        'status', 'active', 'replayVersion', '1', 'lastSequence', '0',
        'replayUnavailable', '0', 'expiresAt', ARGV[6])
      redis.call('PEXPIRE', KEYS[2], ARGV[5])
      redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[5])
      return 1
    `,
      3,
      active,
      metadataKey(identity.runId),
      eventsKey(identity.runId),
      observed ?? '',
      identity.runId,
      identity.threadId,
      identity.userId,
      this.ttlSeconds * 1000,
      Date.now() + this.ttlSeconds * 1000,
      Date.now(),
    );
    return published === 1 ? 'available' : 'unavailable';
  }

  async abandon(identity: ChatRunIdentity): Promise<void> {
    await this.finalize(identity, {
      status: 'error',
      error: 'Stream setup failed',
      replayUnavailable: true,
    });
  }

  async requestCancellation(identity: ChatRunIdentity): Promise<boolean> {
    // Validate and write atomically: a separate HGETALL/HSET can resurrect an
    // expired hash without a TTL or mutate metadata whose ownership changed.
    const accepted = await this.redis.eval(
      `
      local expires = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
      if redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[1]
        or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2]
        or redis.call('HGET', KEYS[1], 'runId') ~= ARGV[3]
        or redis.call('HGET', KEYS[1], 'status') ~= 'active'
        or not expires or expires <= tonumber(ARGV[4])
        or redis.call('PTTL', KEYS[1]) <= 0 then return 0 end
      redis.call('HSET', KEYS[1], 'cancelRequested', '1')
      return 1
    `,
      1,
      metadataKey(identity.runId),
      identity.threadId,
      identity.userId,
      identity.runId,
      Date.now(),
    );
    return accepted === 1;
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
      metadata.runId !== runId ||
      metadata.threadId !== threadId ||
      metadata.userId !== userId
    ) {
      return null;
    }

    return { runId, threadId, userId };
  }

  /** Replays from the beginning, then tails until the producer finalizes. */
  createReplayStream(
    identity: ChatRunIdentity,
    signal?: AbortSignal,
    options?: { readState: ReplayValidator<OwnedRunState> },
  ): ReadableStream<Uint8Array> {
    return createChatReplay({
      redis: this.redis,
      identity,
      metadataKey: metadataKey(identity.runId),
      eventsKey: eventsKey(identity.runId),
      signal,
      readState: options?.readState,
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

export async function beginChatRun(
  identity: ChatRunIdentity,
  options?: BeginOptions,
): Promise<BeginChatRunResult> {
  const result = await withStore((store) => store.begin(identity, options));
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
  // Registration follows durable admission. An older terminal run may still be
  // settling usage; explicit Stop must target the newer local producer, not it.
  const local = [...localRuns.values()]
    .reverse()
    .find((run) => run.identity.threadId === threadId && run.identity.userId === userId);
  if (local) local.abort.abort('user-stop');

  const active = await withStore((store) => store.activeRun(threadId, userId));
  const requested = active ? await withStore((store) => store.requestCancellation(active)) : false;
  return Boolean(local || requested);
}

export async function resumeActiveChatRun(
  threadId: string,
  userId: string,
  signal?: AbortSignal,
  options?: {
    readState: (identity: ChatRunIdentity, signal: AbortSignal) => Promise<OwnedRunState>;
  },
): Promise<{ stream: ReadableStream<Uint8Array>; persistence: 'redis'; runId: string } | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  let identity: ChatRunIdentity | null;
  try {
    identity = await store.activeRun(threadId, userId);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Could not resume chat stream',
    );
    return null;
  }
  if (!identity) return null;
  const owned = identity;
  const readState: ReplayValidator<OwnedRunState> | undefined = options
    ? (checkSignal) => options.readState(owned, checkSignal)
    : undefined;
  // Durable validation failures are not cache absence: let the route report a
  // safe retryable failure rather than silently returning 204 or opening SSE.
  if (readState && (await validateReplayRun(readState, signal)) !== 'streaming') return null;
  return {
    stream: store.createReplayStream(owned, signal, readState ? { readState } : undefined),
    persistence: 'redis',
    runId: owned.runId,
  };
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
