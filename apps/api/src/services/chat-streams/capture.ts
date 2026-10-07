import { logger } from '../../lib/logger.js';
import { isRedisReplyError, isRedisUnavailableError, redisReady } from '../../lib/redis.js';
import { ReplaySnapshot } from '../chat-stream-snapshot.js';
import {
  discardClient,
  noteReadiness,
  redisClient,
  runtimeChatStreamStore,
  withStore,
} from './connection.js';
import { MAX_EVENTS } from './keys.js';
import { unregisterLocalChatRun } from './runs.js';
import type { ChatStreamStore } from './store.js';
import type { ChatRunIdentity, ChatRunOutcome } from './types.js';

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
