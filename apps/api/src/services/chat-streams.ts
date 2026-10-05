import type Redis from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  createRedisClient,
  hashTag,
  isRedisReplyError,
  isRedisUnavailableError,
  type RedisClient,
  redisMode,
  redisReady,
} from '../lib/redis.js';
import type { OwnedRunState } from './chat/run-state.js';
import { type ReplayValidator, validateReplayRun } from './chat-replay-validation.js';
import { createChatReplay } from './chat-stream-replay.js';
import { parseStoredSnapshot, ReplaySnapshot } from './chat-stream-snapshot.js';

const KEY_PREFIX = 'oci:chat-stream';
/** Stream events kept per reply (approximately: Redis trims in whole nodes, never below it). */
export const MAX_EVENTS = 10_000;
/**
 * After an unexpected Redis failure (not a lost connection, which the client
 * reconnects by itself), Redis is left alone for this long, doubling on each
 * further failure up to `REDIS_MAX_RETRY_DELAY_MS`, then a new client is made.
 */
const REDIS_RETRY_DELAY_MS = 1_000;
const REDIS_MAX_RETRY_DELAY_MS = 30_000;
/** The longest the first use of Redis waits for a connection. */
const REDIS_FIRST_CONNECT_MS = 2_000;

/**
 * Capturing a reply through a Redis failover (v0.11 design, item 16). Frames
 * that could not be stored wait in memory and are stored once Redis is back;
 * the newest stored ones are kept too, so that frames a promoted replica never
 * received (asynchronous replication) can be stored again. Past these bounds
 * the reply's live replay is given up, as before.
 */
export const captureRecovery = {
  /** How long a reply keeps its unstored frames while Redis is away. */
  windowMs: 30_000,
  /** At the end of a reply, how long to wait for Redis to store what is left. */
  finalWaitMs: 10_000,
  /** Stored frames kept to repair what a failover lost. */
  keepStored: 256,
};

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

/**
 * The keys of a reply. A run's keys share one hash tag (its id) and the
 * thread's pointer has its own, so on Redis Cluster each script touches one
 * slot; the two operations that touch both (publishing an admitted run and
 * finalizing one) run as two steps there. On one server or Sentinel the names
 * are those of every earlier release (`hashTag` adds no braces).
 */
function chatStreamKeys(cluster: boolean) {
  const tag = (value: string) => hashTag(value, cluster ? 'cluster' : null);
  return {
    active: (threadId: string) => `${KEY_PREFIX}:thread:${tag(threadId)}:active`,
    metadata: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:metadata`,
    events: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:events`,
    snapshot: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:snapshot`,
    /** The producer's heartbeat (v0.11): present while the process writing the reply is alive. */
    alive: (runId: string) => `${KEY_PREFIX}:run:${tag(runId)}:alive`,
  };
}

interface StoreOptions {
  /** Events kept per reply; lowered only in tests. */
  maxEvents?: number;
}

const FINALIZE_RUN_SCRIPT = `
      if redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[1]
        or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[2] then return 0 end
      redis.call('HSET', KEYS[1], 'status', ARGV[4])
      if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
      if ARGV[6] == '1' then redis.call('HSET', KEYS[1], 'replayUnavailable', '1') end
      if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
      redis.call('DEL', KEYS[3])
      return 1
    `;

const DELETE_IF_EQUAL_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

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
  /** Redis Cluster: scripts may touch the keys of one hash slot only. */
  private readonly cluster: boolean;
  private readonly keys: ReturnType<typeof chatStreamKeys>;

  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number,
    options: StoreOptions = {},
  ) {
    this.maxEvents = Math.max(4, Math.floor(options.maxEvents ?? MAX_EVENTS));
    this.snapshotEvery = Math.floor(this.maxEvents / 4);
    this.cluster = (redis as { isCluster?: boolean }).isCluster === true;
    this.keys = chatStreamKeys(this.cluster);
  }

  async begin(identity: ChatRunIdentity, options?: BeginOptions): Promise<BeginChatRunResult> {
    if (options?.admission === 'durable') return this.publishAdmitted(identity);
    const { metadata: metadataKey } = this.keys;
    const active = this.keys.active(identity.threadId);
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
        .eval(DELETE_IF_EQUAL_SCRIPT, 1, active, identity.runId)
        .catch(() => undefined);
      throw error;
    }
  }

  private async publishAdmitted(identity: ChatRunIdentity): Promise<'available' | 'unavailable'> {
    const { metadata: metadataKey, events: eventsKey } = this.keys;
    const active = this.keys.active(identity.threadId);
    const observed = await this.redis.get(active);
    if (this.cluster) return this.publishAdmittedInTwoSteps(identity, observed);
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

  /**
   * `publishAdmitted` on Redis Cluster, where the thread's pointer and the
   * run's keys live in different slots: the run's metadata is created first
   * (only if neither it nor its events exist), then the pointer is swapped
   * from what was observed. If the swap loses, the metadata just created is
   * removed again: nothing can have been appended to it, since only this
   * producer appends, and only after `available`.
   */
  private async publishAdmittedInTwoSteps(
    identity: ChatRunIdentity,
    observed: string | null,
  ): Promise<'available' | 'unavailable'> {
    const active = this.keys.active(identity.threadId);
    const metadata = this.keys.metadata(identity.runId);
    const ttlMs = this.ttlSeconds * 1000;
    if (observed === identity.runId) {
      const valid = await this.redis.eval(
        `
        local expires = tonumber(redis.call('HGET', KEYS[1], 'expiresAt'))
        if redis.call('HGET', KEYS[1], 'runId') == ARGV[1]
          and redis.call('HGET', KEYS[1], 'threadId') == ARGV[2]
          and redis.call('HGET', KEYS[1], 'userId') == ARGV[3]
          and redis.call('HGET', KEYS[1], 'status') == 'active'
          and redis.call('HGET', KEYS[1], 'replayVersion') == '1'
          and redis.call('HGET', KEYS[1], 'replayUnavailable') == '0'
          and expires and expires > tonumber(ARGV[4])
          and redis.call('PTTL', KEYS[1]) > 0 then return 1 end
        return 0
      `,
        1,
        metadata,
        identity.runId,
        identity.threadId,
        identity.userId,
        Date.now(),
      );
      if (valid !== 1) return 'unavailable';
      const still = await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('PTTL', KEYS[1]) > 0 then return 1 end return 0`,
        1,
        active,
        identity.runId,
      );
      return still === 1 ? 'available' : 'unavailable';
    }
    const created = await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      redis.call('HSET', KEYS[1],
        'runId', ARGV[1], 'threadId', ARGV[2], 'userId', ARGV[3],
        'status', 'active', 'replayVersion', '1', 'lastSequence', '0',
        'replayUnavailable', '0', 'expiresAt', ARGV[5])
      redis.call('PEXPIRE', KEYS[1], ARGV[4])
      return 1
    `,
      2,
      metadata,
      this.keys.events(identity.runId),
      identity.runId,
      identity.threadId,
      identity.userId,
      ttlMs,
      Date.now() + ttlMs,
    );
    if (created !== 1) return 'unavailable';
    const swapped = await this.redis
      .eval(
        `
        if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
        return 1
      `,
        1,
        active,
        observed ?? '',
        identity.runId,
        ttlMs,
      )
      .catch(async (error: unknown) => {
        await this.redis.del(metadata).catch(() => undefined);
        throw error;
      });
    if (swapped === 1) return 'available';
    await this.redis.del(metadata);
    return 'unavailable';
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
      this.keys.metadata(identity.runId),
      identity.threadId,
      identity.userId,
      identity.runId,
      Date.now(),
    );
    return accepted === 1;
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    return (await this.redis.hget(this.keys.metadata(runId), 'cancelRequested')) === '1';
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

  /**
   * Stores one frame as event `sequence` of the run, once: if the run already
   * has that event (an earlier attempt was stored, though its answer was lost
   * with the connection) it answers `stored`; if the run has fewer than
   * `sequence - 1` events (a failover lost the newest), it fails with
   * `OCI_GAP <events it has>`, so the producer can store the missing ones
   * again. Used by the producer, which knows its own sequence.
   */
  async appendAt(runId: string, sequence: number, value: string): Promise<'appended' | 'stored'> {
    const result = await this.redis.eval(
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
      local last = tonumber(redis.call('HGET', KEYS[1], 'lastSequence')) or 0
      local wanted = tonumber(ARGV[4])
      if wanted <= last then return 0 end
      if wanted ~= last + 1 then return redis.error_reply('OCI_GAP ' .. last) end
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
      this.keys.metadata(runId),
      this.keys.events(runId),
      Date.now(),
      this.maxEvents,
      value,
      sequence,
    );
    return Number(result) === 0 ? 'stored' : 'appended';
  }

  /** Saves a snapshot taken by the producer when it stands for exactly `sequence` events. */
  async saveSnapshotAt(runId: string, sequence: number, snapshot: ReplaySnapshot): Promise<void> {
    if (sequence % this.snapshotEvery === 0 && snapshot.size === sequence)
      await this.saveSnapshot(runId, sequence, snapshot.frames());
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
      this.keys.metadata(runId),
      this.keys.snapshot(runId),
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
      this.keys.metadata(runId),
      this.keys.events(runId),
      Date.now(),
      this.maxEvents,
      value,
    );
    return Number(sequence);
  }

  async finalize(identity: ChatRunIdentity, outcome: ChatRunOutcome): Promise<void> {
    if (this.cluster) {
      // Two slots: the run first (its status is what readers check), then the
      // thread's pointer, only if it still names this run.
      const finalized = await this.redis.eval(
        FINALIZE_RUN_SCRIPT,
        3,
        this.keys.metadata(identity.runId),
        // No pointer in this slot: GET of a missing key never equals the run.
        `${this.keys.metadata(identity.runId)}:none`,
        this.keys.alive(identity.runId),
        identity.threadId,
        identity.userId,
        identity.runId,
        outcome.status,
        outcome.error?.slice(0, 500) ?? '',
        outcome.replayUnavailable ? '1' : '0',
      );
      if (finalized === 1)
        await this.redis.eval(
          DELETE_IF_EQUAL_SCRIPT,
          1,
          this.keys.active(identity.threadId),
          identity.runId,
        );
      return;
    }
    // Ownership check and deletion must be one operation: an expired active
    // key can be replaced between a client-side GET and a subsequent DEL.
    await this.redis.eval(
      FINALIZE_RUN_SCRIPT,
      3,
      this.keys.metadata(identity.runId),
      this.keys.active(identity.threadId),
      this.keys.alive(identity.runId),
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
    await this.redis.set(this.keys.alive(runId), '1', 'PX', Math.max(1, Math.floor(ttlMs)));
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
      this.keys.alive(runId),
      this.keys.events(runId),
      Math.max(1, Math.floor(windowMs)),
    );
    return active === 1;
  }

  /**
   * Every frame captured for a run so far, in order (starting from the saved
   * snapshot when the oldest events were trimmed), or null when any is missing.
   */
  async capturedFrames(runId: string): Promise<string[] | null> {
    const metadata = await this.redis.hgetall(this.keys.metadata(runId));
    const total = Number(metadata.lastSequence);
    if (metadata.runId !== runId || !Number.isSafeInteger(total) || total < 0) return null;
    const entries = await this.redis.xrange(this.keys.events(runId), '-', '+');
    const events = entries.map(([, fields]) => {
      const values: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) values[fields[i]!] = fields[i + 1]!;
      return { seq: Number(values.seq), data: values.data };
    });
    let frames: string[] = [];
    let next = 1;
    const first = events[0]?.seq;
    if (first !== undefined && first > 1) {
      const snapshot = parseStoredSnapshot(await this.redis.get(this.keys.snapshot(runId)));
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

  /** How many events of the run are stored, or null when it has no metadata. */
  async storedSequence(runId: string): Promise<number | null> {
    const value = await this.redis.hget(this.keys.metadata(runId), 'lastSequence');
    return value === null ? null : Number(value);
  }

  async activeRunId(threadId: string): Promise<string | null> {
    return this.redis.get(this.keys.active(threadId));
  }

  async activeRun(threadId: string, userId: string): Promise<ChatRunIdentity | null> {
    const runId = await this.redis.get(this.keys.active(threadId));
    if (!runId) return null;

    const metadata = await this.redis.hgetall(this.keys.metadata(runId));
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
      metadataKey: this.keys.metadata(identity.runId),
      eventsKey: this.keys.events(identity.runId),
      snapshotKey: this.keys.snapshot(identity.runId),
      signal,
      readState: options?.readState,
      checkProducer: options?.checkProducer,
      onEnd: options?.onEnd,
    });
  }
}

let runtimeStore: ChatStreamStore | null = null;
let redisClient: RedisClient | null = null;
let redisUnavailableUntil = 0;
let redisFailures = 0;
/** Whether Redis was ready the last time it was looked at, for logging changes only. */
let redisWasReady: boolean | null = null;

function noteReadiness(ready: boolean, detail?: string) {
  if (redisWasReady === ready) return;
  // The first look at a working Redis says nothing; every change is logged.
  if (ready && redisWasReady !== null) logger.info('Redis is available again');
  if (!ready)
    logger.warn(
      { err: detail },
      'Redis unavailable: replies are not resumable, rate limits and concurrency caps count per replica, until it is back',
    );
  redisWasReady = ready;
}

/** Drops the current client after an unexpected failure; a new one is made after a pause. */
function discardClient(error: unknown) {
  redisFailures++;
  redisUnavailableUntil =
    Date.now() +
    Math.min(REDIS_RETRY_DELAY_MS * 2 ** (redisFailures - 1), REDIS_MAX_RETRY_DELAY_MS);
  runtimeStore = null;
  redisClient?.disconnect();
  redisClient = null;
  noteReadiness(false, error instanceof Error ? error.message : String(error));
}

/**
 * The store on the shared client, or null while Redis is unconfigured or not
 * connected. The first use waits (briefly) for the connection; after that a
 * client that lost its connection reconnects in the background (to the new
 * primary, with Sentinel or Cluster) and this answers null without waiting
 * until it is back, so no request waits on Redis while it is away.
 */
async function runtimeChatStreamStore(): Promise<ChatStreamStore | null> {
  const env = loadEnv();
  if (!redisMode(env) || Date.now() < redisUnavailableUntil) return null;
  // Callers arriving while the client's first connection is made wait for it.
  if (firstConnection) await firstConnection;
  if (runtimeStore && redisClient && redisClient.status !== 'end') {
    const ready = redisReady(redisClient);
    noteReadiness(ready);
    return ready ? runtimeStore : null;
  }

  const client = createRedisClient(env);
  if (!client) return null;
  client.on('error', () => undefined);
  redisClient = client;
  const store = new ChatStreamStore(client, env.CHAT_STREAM_TTL_SECONDS);
  runtimeStore = store;
  const connecting = connectFirst(client);
  firstConnection = connecting;
  const connected = await connecting.finally(() => {
    if (firstConnection === connecting) firstConnection = null;
  });
  if (connected === true && redisReady(client)) {
    redisFailures = 0;
    noteReadiness(true);
    return store;
  }
  noteReadiness(
    false,
    connected instanceof Error ? connected.message : 'Timed out connecting to Redis',
  );
  return null;
}

let firstConnection: Promise<unknown> | null = null;

/**
 * The first connection of a new client, bounded: with Sentinel, connect()
 * keeps asking the sentinels for as long as none answers. It goes on in the
 * background either way.
 */
async function connectFirst(client: RedisClient): Promise<true | false | Error> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    client.connect().then(
      () => true as const,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), REDIS_FIRST_CONNECT_MS);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The shared Redis connection, or null when Redis is unconfigured or down.
 *
 * Rate limiting and concurrency caps reuse this rather than opening a second
 * connection: they need the same availability signal, and a limiter that
 * silently used a different client could disagree about whether Redis works.
 *
 * With Redis Cluster this is a `Cluster` (typed as `Redis` for the callers
 * written before v0.11; it has the same commands). Keys used together in one
 * MULTI or script need a shared hash tag there (`hashTag`, lib/redis.ts).
 * `sharedRedisClient()` is the same client with its real type.
 */
export async function sharedRedis(): Promise<Redis | null> {
  return (await sharedRedisClient()) as Redis | null;
}

export async function sharedRedisClient(): Promise<RedisClient | null> {
  return (await runtimeChatStreamStore()) ? redisClient : null;
}

/**
 * How long a reader asking to resume a reply waits for a Redis client that is
 * reconnecting (a Sentinel or Cluster failover takes a few seconds), rather
 * than being told at once that there is nothing to resume.
 */
export const resumeWait = { ms: 5_000, intervalMs: 100 };

async function storeAfterReconnect(signal?: AbortSignal): Promise<ChatStreamStore | null> {
  const deadline = Date.now() + resumeWait.ms;
  // Only a client that exists and is reconnecting is worth waiting for.
  while (redisClient && redisClient.status !== 'end' && !signal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, resumeWait.intervalMs));
    const store = await runtimeChatStreamStore();
    if (store) return store;
  }
  return null;
}

/** Whether Redis is configured at all (one server, Sentinel or Cluster). */
export function redisConfigured(): boolean {
  return redisMode(loadEnv()) !== null;
}

/**
 * For other users of the shared client (rate limits, concurrency caps): a
 * command that timed out on a connection that still looks open means the
 * server stopped answering, so reconnect (to the new primary after a
 * failover) instead of letting every later command wait for its timeout.
 */
export function noteRedisFailure(error: unknown): void {
  if (!isRedisUnavailableError(error)) return;
  if (redisReady(redisClient) && /timed out/i.test((error as Error).message))
    redisClient.disconnect(true);
  noteReadiness(false, (error as Error).message);
}

async function withStore<T>(operation: (store: ChatStreamStore) => Promise<T>): Promise<T | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    return await operation(store);
  } catch (error) {
    if (isRedisReplyError(error) && !isRedisUnavailableError(error)) {
      // Redis answered: this operation was refused (an expired or finished
      // run), which says nothing about Redis itself.
      logger.warn({ err: error.message }, 'Resumable chat stream operation refused');
      return null;
    }
    if (isRedisUnavailableError(error) && redisClient?.status !== 'end') {
      // The client reconnects by itself. A command that timed out on a
      // connection that still looks open (a primary that stopped answering)
      // means it is not: reconnect, to the new primary after a failover.
      if (redisReady(redisClient) && /timed out/i.test((error as Error).message))
        redisClient.disconnect(true);
      noteReadiness(false, (error as Error).message);
      return null;
    }
    discardClient(error);
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
  if (!redisConfigured()) return 'disabled';
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
  const store = (await runtimeChatStreamStore()) ?? (await storeAfterReconnect(signal));
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

/** A reply's capture cannot continue: its live replay is given up. */
class CaptureLost extends Error {}

/**
 * The producer's side of a reply's capture: which frames are stored, which
 * still wait for Redis, and the newest stored ones (to store again what a
 * failover lost). Frames are stored in order, each at its own sequence
 * number, so storing one twice is harmless (`appendAt`).
 */
class CaptureState {
  stored = 0;
  readonly pending: string[] = [];
  /** Frames `stored - recent.length + 1` to `stored`. */
  readonly recent: string[] = [];
  /** Since when Redis has not taken a frame; null while it does. */
  failingSince: number | null = null;
  private observed = 0;

  constructor(
    private readonly runId: string,
    private readonly snapshot: ReplaySnapshot,
  ) {}

  /** Stores every pending frame; throws on the first that cannot be stored. */
  async flush(store: ChatStreamStore): Promise<void> {
    while (this.pending.length > 0) {
      const frame = this.pending[0]!;
      const sequence = this.stored + 1;
      try {
        await store.appendAt(this.runId, sequence, frame);
      } catch (error) {
        const gap = isRedisReplyError(error) ? /^OCI_GAP (\d+)/.exec(error.message) : null;
        if (!gap) throw error;
        this.rewind(Number(gap[1]));
        continue;
      }
      this.pending.shift();
      this.recent.push(frame);
      if (this.recent.length > captureRecovery.keepStored) this.recent.shift();
      this.stored = sequence;
      this.failingSince = null;
      if (sequence > this.observed) {
        this.snapshot.observe(frame);
        this.observed = sequence;
        await store.saveSnapshotAt(this.runId, sequence, this.snapshot);
      }
    }
  }

  /**
   * Redis has only `have` events (a replica promoted before it received the
   * newest): store the missing ones again, if they are still kept.
   */
  private rewind(have: number) {
    const missing = this.stored - have;
    if (missing <= 0 || missing > this.recent.length) {
      throw new CaptureLost(`Redis has ${have} of ${this.stored} stored events`);
    }
    this.pending.unshift(...this.recent.splice(this.recent.length - missing, missing));
    this.stored = have;
    logger.warn(
      { runId: this.runId, missing },
      'A Redis failover lost the newest events of a reply; storing them again',
    );
  }
}

/**
 * Tries to store what is pending. False when Redis is away (the frames stay
 * pending); throws `CaptureLost` when the capture cannot be completed.
 */
async function flushCapture(state: CaptureState): Promise<boolean> {
  const store = await runtimeChatStreamStore();
  if (store) {
    try {
      await state.flush(store);
      return true;
    } catch (error) {
      if (error instanceof CaptureLost) throw error;
      // Redis refused the frame (the run expired or was finished elsewhere).
      if (isRedisReplyError(error) && !isRedisUnavailableError(error))
        throw new CaptureLost(error.message);
      if (isRedisUnavailableError(error) && redisClient?.status !== 'end') {
        if (redisReady(redisClient) && /timed out/i.test((error as Error).message))
          redisClient.disconnect(true);
        noteReadiness(false, (error as Error).message);
      } else {
        discardClient(error);
      }
    }
  }
  state.failingSince ??= Date.now();
  if (
    Date.now() - state.failingSince > captureRecovery.windowMs ||
    state.pending.length > MAX_EVENTS
  )
    throw new CaptureLost('Redis was unavailable for too long');
  return false;
}

export async function captureChatRun(
  identity: ChatRunIdentity,
  stream: ReadableStream<string>,
  getOutcome: () => ChatRunOutcome,
): Promise<void> {
  const reader = stream.getReader();
  let persistenceFailed = false;
  const state = new CaptureState(identity.runId, new ReplaySnapshot());

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (persistenceFailed) continue;

      state.pending.push(value);
      try {
        await flushCapture(state);
      } catch {
        persistenceFailed = true;
      }
    }
    // The reply is complete; what Redis has not taken yet is stored once it
    // is back (a Sentinel or Cluster failover takes seconds), within a limit.
    const deadline = Date.now() + captureRecovery.finalWaitMs;
    while (!persistenceFailed && state.pending.length > 0) {
      try {
        if (await flushCapture(state)) break;
      } catch {
        persistenceFailed = true;
        break;
      }
      if (Date.now() >= deadline) {
        persistenceFailed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
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
