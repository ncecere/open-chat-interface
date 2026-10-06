import type { RedisClient } from '../../lib/redis.js';
import type { OwnedRunState } from '../chat/run-state.js';
import type { ReplayValidator } from '../chat-replay-validation.js';
import { createChatReplay } from '../chat-stream-replay.js';
import { parseStoredSnapshot, type ReplaySnapshot } from '../chat-stream-snapshot.js';
import { chatStreamKeys, DELETE_IF_EQUAL_SCRIPT, FINALIZE_RUN_SCRIPT, MAX_EVENTS } from './keys.js';
import type { BeginChatRunResult, BeginOptions, ChatRunIdentity, ChatRunOutcome } from './types.js';

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
   * How long until producerActive(runId, windowMs) turns false if the producer
   * stays silent: the heartbeat's remaining lifetime or the time until the
   * last captured event is `windowMs` old, whichever is later; 0 when it
   * already is. The 409 for an interrupted reply counts down with it (#163).
   */
  async producerQuietInMs(runId: string, windowMs: number): Promise<number> {
    const remaining = await this.redis.eval(
      `
      local wait = 0
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl > 0 then wait = ttl end
      local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
      if #last > 0 then
        local at = tonumber(string.match(last[1][1], '^(%d+)'))
        local now = redis.call('TIME')
        local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
        if at and tonumber(ARGV[1]) - (nowMs - at) > wait then wait = tonumber(ARGV[1]) - (nowMs - at) end
      end
      return wait
    `,
      2,
      this.keys.alive(runId),
      this.keys.events(runId),
      Math.max(1, Math.floor(windowMs)),
    );
    return Math.max(0, Number(remaining) || 0);
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
