import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { OwnedRunState } from './chat/run-state.js';
import { type ReplayValidator, validateReplayRun } from './chat-replay-validation.js';
import { createChatReplay } from './chat-stream-replay.js';
import { parseStoredSnapshot, ReplaySnapshot } from './chat-stream-snapshot.js';

const KEY_PREFIX = 'oci:chat-stream';
/** Stream events kept per reply (approximately: Redis trims in whole nodes, never below it). */
export const MAX_EVENTS = 10_000;
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

function snapshotKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:snapshot`;
}

/** The producer's heartbeat (v0.11): present while the process writing the reply is alive. */
function aliveKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:alive`;
}

interface StoreOptions {
  /** Events kept per reply; lowered only in tests. */
  maxEvents?: number;
}

/** Redis persistence for one bounded, owner-scoped AI SDK SSE stream. */
export class ChatStreamStore {
  private readonly maxEvents: number;
  /**
   * How often a compact snapshot is saved, in events. A quarter of the kept
   * events: Redis never keeps fewer than `maxEvents`, so the newest snapshot
   * always reaches the oldest kept event and a trimmed replay can continue
   * from it without a gap.
   */
  readonly snapshotEvery: number;

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    options: StoreOptions = {},
  ) {
    this.maxEvents = Math.max(4, Math.floor(options.maxEvents ?? MAX_EVENTS));
    this.snapshotEvery = Math.floor(this.maxEvents / 4);
  }

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

  /**
   * Appends one SSE frame and returns its sequence number. With a snapshot,
   * the frame is added to it and the snapshot is saved every `snapshotEvery`
   * events, so a replay whose prefix was trimmed can start from it.
   */
  async append(runId: string, value: string, snapshot?: ReplaySnapshot): Promise<number> {
    const sequence = await this.appendEvent(runId, value);
    if (snapshot) {
      snapshot.observe(value);
      if (sequence % this.snapshotEvery === 0 && snapshot.size === sequence)
        await this.saveSnapshot(runId, sequence, snapshot.frames());
    }
    return sequence;
  }

  /** Saves the frames standing for events 1..sequence, while the run's metadata lives. */
  private async saveSnapshot(runId: string, sequence: number, frames: string[]): Promise<void> {
    await this.redis.eval(
      `
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 or redis.call('HGET', KEYS[1], 'runId') ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
      return 1
    `,
      2,
      metadataKey(runId),
      snapshotKey(runId),
      runId,
      JSON.stringify({ sequence, frames }),
    );
  }

  private async appendEvent(runId: string, value: string): Promise<number> {
    // One operation: metadata cannot expire between validation and XADD, and
    // sequence gaps remain detectable even when MAXLEN drops the SSE prefix.
    // Increment before XADD: if the latter fails, replay sees a missing event
    // rather than mistaking a partial cache for successful completion.
    const sequence = await this.redis.eval(
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
      this.maxEvents,
      value,
    );
    return Number(sequence);
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
      redis.call('DEL', KEYS[3])
      return 1
    `,
      3,
      metadataKey(identity.runId),
      activeKey(identity.threadId),
      aliveKey(identity.runId),
      identity.threadId,
      identity.userId,
      identity.runId,
      outcome.status,
      outcome.error?.slice(0, 500) ?? '',
      outcome.replayUnavailable ? '1' : '0',
    );
  }

  /** Refreshes the producer heartbeat; it lapses `ttlMs` after the last refresh. */
  async touchAlive(runId: string, ttlMs: number): Promise<void> {
    await this.redis.set(aliveKey(runId), '1', 'PX', Math.max(1, Math.floor(ttlMs)));
  }

  /**
   * Whether the run's producer showed a sign of life within `windowMs`: its
   * heartbeat, or an event captured that recently. Releases before v0.11 have
   * no heartbeat, so during a rolling upgrade their events are the only sign.
   * Both are measured on Redis's clock, never a replica's.
   */
  async producerActive(runId: string, windowMs: number): Promise<boolean> {
    const active = await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
      local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
      if #last == 0 then return 0 end
      local at = tonumber(string.match(last[1][1], '^(%d+)'))
      local now = redis.call('TIME')
      local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
      if at and nowMs - at < tonumber(ARGV[1]) then return 1 end
      return 0
    `,
      2,
      aliveKey(runId),
      eventsKey(runId),
      Math.max(1, Math.floor(windowMs)),
    );
    return active === 1;
  }

  /**
   * Every frame captured for a run so far, in order (starting from the saved
   * snapshot when the oldest events were trimmed), or null when any is missing.
   */
  async capturedFrames(runId: string): Promise<string[] | null> {
    const metadata = await this.redis.hgetall(metadataKey(runId));
    const total = Number(metadata.lastSequence);
    if (metadata.runId !== runId || !Number.isSafeInteger(total) || total < 0) return null;
    const entries = await this.redis.xrange(eventsKey(runId), '-', '+');
    const events = entries.map(([, fields]) => {
      const values: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) values[fields[i]!] = fields[i + 1]!;
      return { seq: Number(values.seq), data: values.data };
    });
    let frames: string[] = [];
    let next = 1;
    const first = events[0]?.seq;
    if (first !== undefined && first > 1) {
      const snapshot = parseStoredSnapshot(await this.redis.get(snapshotKey(runId)));
      if (!snapshot || snapshot.sequence + 1 < first) return null;
      frames = [...snapshot.frames];
      next = snapshot.sequence + 1;
    }
    for (const { seq, data } of events) {
      if (seq < next) continue;
      if (seq !== next || data === undefined) return null;
      frames.push(data);
      next++;
    }
    return next - 1 === total ? frames : null;
  }

  async activeRunId(threadId: string): Promise<string | null> {
    return this.redis.get(activeKey(threadId));
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
    options?: {
      readState?: ReplayValidator<OwnedRunState>;
      checkProducer?: () => Promise<boolean>;
      onEnd?: () => void;
    },
  ): ReadableStream<Uint8Array> {
    return createChatReplay({
      redis: this.redis,
      identity,
      metadataKey: metadataKey(identity.runId),
      eventsKey: eventsKey(identity.runId),
      snapshotKey: snapshotKey(identity.runId),
      signal,
      readState: options?.readState,
      checkProducer: options?.checkProducer,
      onEnd: options?.onEnd,
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

/** The producer heartbeat (v0.11); best effort, like every cache write. */
export async function touchChatRunHeartbeat(runId: string, ttlMs: number): Promise<void> {
  await withStore((store) => store.touchAlive(runId, ttlMs));
}

/** Null when Redis is unavailable, so the caller decides from PostgreSQL alone. */
export async function chatRunProducerActive(
  runId: string,
  windowMs: number,
): Promise<boolean | null> {
  return withStore((store) => store.producerActive(runId, windowMs));
}

export async function capturedChatRunFrames(runId: string): Promise<string[] | null> {
  return withStore((store) => store.capturedFrames(runId));
}

export async function activeChatRunId(threadId: string): Promise<string | null> {
  return withStore((store) => store.activeRunId(threadId));
}

/**
 * Ends a run's cached stream as cancelled for a producer that is gone, so
 * every replay reader finishes with what was captured instead of waiting.
 */
export async function finalizeInterruptedChatRun(
  identity: ChatRunIdentity,
  error: string,
): Promise<void> {
  await withStore((store) => store.finalize(identity, { status: 'cancelled', error }));
}

const replayReaders = new Set<AbortController>();

/** Ends this process's replay readers cleanly (shutdown); their clients resume elsewhere. */
export function endChatReplays(): number {
  const count = replayReaders.size;
  for (const reader of replayReaders) reader.abort();
  replayReaders.clear();
  return count;
}

/** Closes the shared Redis connection for good (shutdown). */
export async function closeChatStreams(): Promise<void> {
  const client = redisClient;
  runtimeStore = null;
  redisClient = null;
  redisUnavailableUntil = Number.POSITIVE_INFINITY;
  if (client) await client.quit().catch(() => client.disconnect());
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
  const ending = new AbortController();
  replayReaders.add(ending);
  const scoped = signal ? AbortSignal.any([signal, ending.signal]) : ending.signal;
  return {
    stream: store.createReplayStream(owned, scoped, {
      readState,
      // A reader is also how a reply whose producer died gets noticed: it
      // ends the run as interrupted, then finishes with what was captured.
      ...(readState && {
        checkProducer: async () => {
          const { recoverInterruptedRun } = await import('./chat/run-recovery.js');
          return recoverInterruptedRun(owned);
        },
      }),
      onEnd: () => replayReaders.delete(ending),
    }),
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
  const snapshot = new ReplaySnapshot();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (persistenceFailed) continue;

      const stored = await withStore(async (store) => {
        await store.append(identity.runId, value, snapshot);
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
