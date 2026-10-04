import type Redis from 'ioredis';
import type { OwnedRunState } from './chat/run-state.js';
import { type ReplayValidator, validateReplayRun } from './chat-replay-validation.js';
import { parseStoredSnapshot } from './chat-stream-snapshot.js';

export const REPLAY_UNAVAILABLE_MESSAGE =
  'Live replay is no longer available. Reload this conversation to see saved messages; a response may still be running.';
const POLL_MS = 100;
const BATCH_SIZE = 200;
const VALIDATION_INTERVAL_MS = 2000;
/** How often an idle reader asks whether the reply's producer is still alive. */
const PRODUCER_CHECK_MS = 5000;

function sequence(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

// The pinned SDK's JsonToSseTransformStream emits one complete frame per string.
// Unrecognized/fragmented frames never establish successful completion. This
// does not synthesize a finish: the actual frame must have been forwarded.
function isFinishFrame(value: string): boolean {
  if (!value.startsWith('data:') || !value.endsWith('\n\n')) return false;
  try {
    return JSON.parse(value.slice(5, -2))?.type === 'finish';
  } catch {
    return false;
  }
}

/** Replay failure affects this reader only, never the producer or its admission claim. */
export function createChatReplay(options: {
  redis: Redis;
  identity: { runId: string; threadId: string; userId: string };
  metadataKey: string;
  eventsKey: string;
  /** A compact copy of the stream's start, used when its oldest events were trimmed. */
  snapshotKey?: string;
  signal?: AbortSignal;
  readState?: ReplayValidator<OwnedRunState>;
  /**
   * Ends the run as interrupted when its producer is gone, returning true if it
   * did (services/chat/run-recovery.ts). The reader then finishes cleanly with
   * what was captured instead of waiting for a producer that no longer exists.
   */
  checkProducer?: () => Promise<boolean>;
  /** Called once when this reader closes or is cancelled. */
  onEnd?: () => void;
}): ReadableStream<Uint8Array> {
  const { redis, identity, metadataKey, eventsKey, snapshotKey, readState, checkProducer } =
    options;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    options.onEnd?.();
  };
  // The first idle moment checks at once: a reader often arrives after the crash.
  let nextProducerCheck = 0;
  let lastStatus: string | undefined;
  const cancellation = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, cancellation.signal])
    : cancellation.signal;
  let nextValidation = performance.now() + VALIDATION_INTERVAL_MS;
  const encoder = new TextEncoder();
  let cancelled = false;
  let lastId = '0-0';
  let lastSequence = 0;
  let batch: Array<[string, string[]]> = [];
  let index = 0;
  let finishDelivered = false;
  let durableTerminal = false;
  let terminalLimit: number | null = null;
  // Seeding from a snapshot: its frames still to send, and the events it stands for.
  let seeded = false;
  let seedFrames: string[] = [];
  let skipThrough = 0;

  return new ReadableStream<Uint8Array>({
    // Pull, rather than an eager start loop, bounds queued replay data to a
    // single Redis batch plus the stream's one-chunk high-water mark.
    async pull(controller) {
      try {
        while (!cancelled && !signal?.aborted) {
          if (terminalLimit !== null && lastSequence >= terminalLimit) {
            // A cancelled run (stopped, or interrupted by a shutdown or crash)
            // has no finish frame: everything captured has been forwarded.
            if (!finishDelivered && lastStatus !== 'cancelled')
              throw new Error('Terminal replay has no captured finish');
            controller.close();
            end();
            return;
          }
          if (seedFrames.length) {
            const frame = seedFrames.shift()!;
            controller.enqueue(encoder.encode(frame));
            finishDelivered ||= isFinishFrame(frame);
            return;
          }
          if (index < batch.length) {
            const [id, fields] = batch[index++]!;
            const values: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              const key = fields[i];
              const value = fields[i + 1];
              if (key !== undefined && value !== undefined) values[key] = value;
            }
            const seq = sequence(values.seq);
            // Already sent as part of the snapshot.
            if (seq !== null && seq <= skipThrough) {
              lastId = id;
              continue;
            }
            if (seq !== lastSequence + 1 || values.data === undefined) {
              // The oldest events were trimmed (a very long reply): start from
              // the saved snapshot instead, once, then continue with events.
              if (lastSequence === 0 && !seeded && snapshotKey && seq !== null && seq > 1) {
                seeded = true;
                const snapshot = parseStoredSnapshot(await redis.get(snapshotKey));
                if (!snapshot || snapshot.sequence + 1 < seq)
                  throw new Error('Replay sequence gap');
                seedFrames = snapshot.frames;
                lastSequence = snapshot.sequence;
                skipThrough = snapshot.sequence;
                // Read again from the start, skipping what the snapshot covers.
                lastId = '0-0';
                batch = [];
                index = 0;
                continue;
              }
              throw new Error('Replay sequence gap');
            }
            lastId = id;
            lastSequence++;
            controller.enqueue(encoder.encode(values.data));
            finishDelivered ||= isFinishFrame(values.data);
            return;
          }
          const metadata = await redis.hgetall(metadataKey);
          lastStatus = metadata.status;
          const total = sequence(metadata.lastSequence);
          if (
            metadata.runId !== identity.runId ||
            metadata.threadId !== identity.threadId ||
            metadata.userId !== identity.userId ||
            metadata.replayVersion !== '1' ||
            metadata.replayUnavailable !== '0' ||
            !Number.isFinite(Number(metadata.expiresAt)) ||
            Number(metadata.expiresAt) <= Date.now() ||
            total === null ||
            total < lastSequence ||
            !['active', 'complete', 'error', 'cancelled'].includes(metadata.status ?? '')
          )
            throw new Error('Replay metadata unavailable');
          // Reconcile once after a terminal durable check: completion may have
          // arrived during that query. Freeze the tail boundary so a still-active
          // cache cannot keep this reader following new events indefinitely.
          if (durableTerminal) terminalLimit ??= total;
          if (terminalLimit !== null && lastSequence >= terminalLimit) continue;
          batch = await redis.xrange(eventsKey, `(${lastId}`, '+', 'COUNT', BATCH_SIZE);
          index = 0;
          if (batch.length) continue;
          // A vanished suffix must not look like a successful/idle stream.
          if (total > lastSequence) throw new Error('Replay events missing');
          if (metadata.status !== 'active') {
            if (!lastSequence) throw new Error('Replay never captured a prefix');
            if (!cancelled) controller.close();
            end();
            return;
          }
          if (readState && performance.now() >= nextValidation) {
            const state = await validateReplayRun(readState, signal);
            if (state !== 'streaming') {
              // Missing/deleted/expired/foreign ownership is not completion and
              // must not authorize forwarding any newly cached suffix.
              if (state !== 'terminal') throw new Error('Durable run unavailable');
              durableTerminal = true;
              continue;
            }
            nextValidation = performance.now() + VALIDATION_INTERVAL_MS;
          }
          if (checkProducer && performance.now() >= nextProducerCheck) {
            nextProducerCheck = performance.now() + PRODUCER_CHECK_MS;
            let recovered = false;
            try {
              recovered = await checkProducer();
            } catch {
              // A failed check is not evidence either way; look again later.
            }
            if (recovered) continue;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        if (!cancelled) controller.close();
        end();
      } catch {
        end();
        if (cancelled) return;
        if (!signal?.aborted) {
          // This is an SDK protocol error, not a raw HTTP stream failure or a
          // fabricated text-start for a reply whose prefix we no longer have.
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'error', errorText: REPLAY_UNAVAILABLE_MESSAGE })}\n\ndata: [DONE]\n\n`,
            ),
          );
        }
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      cancellation.abort();
      end();
    },
  });
}
