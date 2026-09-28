import type Redis from 'ioredis';

export const REPLAY_UNAVAILABLE_MESSAGE =
  'Live replay is no longer available. Reload this conversation to see saved messages; a response may still be running.';
const POLL_MS = 100;
const BATCH_SIZE = 200;

function sequence(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

/** Replay failure affects this reader only, never the producer or its admission claim. */
export function createChatReplay(options: {
  redis: Redis;
  identity: { threadId: string; userId: string };
  metadataKey: string;
  eventsKey: string;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  const { redis, identity, metadataKey, eventsKey, signal } = options;
  const encoder = new TextEncoder();
  let cancelled = false;
  let lastId = '0-0';
  let lastSequence = 0;
  let batch: Array<[string, string[]]> = [];
  let index = 0;

  return new ReadableStream<Uint8Array>({
    // Pull, rather than an eager start loop, bounds queued replay data to a
    // single Redis batch plus the stream's one-chunk high-water mark.
    async pull(controller) {
      try {
        while (!cancelled && !signal?.aborted) {
          if (index < batch.length) {
            const [id, fields] = batch[index++]!;
            const values: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              const key = fields[i];
              const value = fields[i + 1];
              if (key !== undefined && value !== undefined) values[key] = value;
            }
            if (sequence(values.seq) !== lastSequence + 1 || values.data === undefined)
              throw new Error('Replay sequence gap');
            lastId = id;
            lastSequence++;
            controller.enqueue(encoder.encode(values.data));
            return;
          }
          const metadata = await redis.hgetall(metadataKey);
          const total = sequence(metadata.lastSequence);
          if (
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
          batch = await redis.xrange(eventsKey, `(${lastId}`, '+', 'COUNT', BATCH_SIZE);
          index = 0;
          if (batch.length) continue;
          // A vanished suffix must not look like a successful/idle stream.
          if (total > lastSequence) throw new Error('Replay events missing');
          if (metadata.status !== 'active') {
            if (!lastSequence) throw new Error('Replay never captured a prefix');
            if (!cancelled) controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        if (!cancelled) controller.close();
      } catch {
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
    },
  });
}
