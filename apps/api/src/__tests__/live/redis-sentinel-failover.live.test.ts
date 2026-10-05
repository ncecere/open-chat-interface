import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dockerAvailable } from '../../../test/pgbouncer.js';
import { type RedisSentinelSet, startRedisSentinel } from '../../../test/redis-ha.js';

/**
 * A Redis failover under Sentinel (v0.11 design, item 16): a primary, a
 * replica and three sentinels; the primary is killed (SIGKILL) while a reply
 * is being written and read back, and while rate limits are being counted.
 *
 * - the reply's capture keeps the frames Redis could not take and stores
 *   them on the new primary (again, if the promoted replica had not received
 *   the newest), so the reader that was following it finishes with every
 *   frame, in order, once;
 * - rate limits never fail a request: they count in-process while Redis is
 *   away and in Redis again once the client follows the new primary;
 * - nothing throws outside a promise, and no call waits longer than the
 *   command timeout.
 */
const state = vi.hoisted(() => ({ sentinels: '', name: '' }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({
    REDIS_SENTINELS: state.sentinels,
    REDIS_SENTINEL_NAME: state.name,
    REDIS_COMMAND_TIMEOUT_MS: 1_000,
    CHAT_STREAM_TTL_SECONDS: 300,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const available = await dockerAvailable();

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe.skipIf(!available)('live Redis Sentinel failover', () => {
  let redis: RedisSentinelSet;
  let streams: typeof import('../../services/chat-streams.js');
  let limits: typeof import('../../services/limits/rate-limit.js');
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    redis = await startRedisSentinel();
    state.sentinels = redis.sentinels;
    state.name = redis.masterName;
    streams = await import('../../services/chat-streams.js');
    limits = await import('../../services/limits/rate-limit.js');
    expect(await streams.sharedRedisClient()).not.toBeNull();
  }, 120_000);

  afterAll(async () => {
    await streams?.closeChatStreams();
    await redis?.stop();
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  });

  it('finishes a reply and its reader, and keeps counting rate limits, through a failover', async () => {
    const id = randomUUID();
    const identity = { runId: `run-${id}`, threadId: `thread-${id}`, userId: `user-${id}` };
    expect(await streams.beginChatRun(identity)).toBe('available');

    // About eight seconds of reply: start, 300 deltas 25 ms apart, finish.
    const frames = [
      sse({ type: 'start' }),
      sse({ type: 'text-start', id: 't' }),
      ...Array.from({ length: 300 }, (_, n) =>
        sse({ type: 'text-delta', id: 't', delta: `${n} ` }),
      ),
      sse({ type: 'text-end', id: 't' }),
      sse({ type: 'finish' }),
    ];
    let sent = 0;
    const reply = new ReadableStream<string>({
      async pull(controller) {
        if (sent === frames.length) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.enqueue(frames[sent++]!);
      },
    });
    const capture = streams.captureChatRun(identity, reply, () => ({ status: 'complete' }));

    // A reader following the reply from (nearly) the start.
    await vi.waitFor(() => expect(sent).toBeGreaterThan(20), { timeout: 5_000, interval: 20 });
    const resumed = await streams.resumeActiveChatRun(identity.threadId, identity.userId);
    expect(resumed).not.toBeNull();
    const reading = new Response(resumed!.stream).text();

    // Rate limits, counted every 20 ms throughout.
    let counting = true;
    const counts: number[] = [];
    const rateErrors: unknown[] = [];
    let slowest = 0;
    const counter = (async () => {
      while (counting) {
        const started = performance.now();
        try {
          const result = await limits.consumeRateLimit({
            bucket: 'failover-test',
            identifier: id,
            limit: 1_000_000,
          });
          counts.push(1_000_000 - result.remaining);
        } catch (error) {
          rateErrors.push(error);
        }
        slowest = Math.max(slowest, performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    // Mid-reply: kill the primary.
    await vi.waitFor(() => expect(sent).toBeGreaterThan(100), { timeout: 10_000, interval: 20 });
    const killedAt = Date.now();
    const oldPrimary = await redis.killPrimary();
    await vi.waitFor(async () => expect(await redis.currentPrimaryPort()).not.toBe(oldPrimary), {
      timeout: 30_000,
      interval: 100,
    });
    const promotedAt = Date.now();
    await vi.waitFor(async () => expect(await streams.sharedRedisClient()).not.toBeNull(), {
      timeout: 30_000,
      interval: 50,
    });
    const followedAt = Date.now();

    await capture;
    const text = await reading;
    counting = false;
    await counter;

    // Every frame, in order, once.
    expect(text).toBe(frames.join(''));
    // Stored complete on the new primary, replay intact.
    const client = await streams.sharedRedisClient();
    const metadata = await client!.hgetall(`oci:chat-stream:run:${identity.runId}:metadata`);
    expect(metadata).toMatchObject({
      status: 'complete',
      lastSequence: String(frames.length),
      replayUnavailable: '0',
    });
    expect(await streams.capturedChatRunFrames(identity.runId)).toEqual(frames);

    // Rate limits: no request failed or waited past the command timeout, and
    // counting in Redis resumed (the newest counts come from Redis, which
    // started again from the new primary's copy of the window).
    expect(rateErrors).toEqual([]);
    expect(slowest).toBeLessThan(1_500);
    expect(counts.length).toBeGreaterThan(50);
    const stored = await client!.get(
      `oci:limit:failover-test:${id}:${Math.floor(Date.now() / 60_000)}`,
    );
    expect(Number(stored)).toBeGreaterThan(0);
    expect(uncaught).toEqual([]);

    console.info(
      `Redis failover: primary killed; promoted after ${promotedAt - killedAt} ms; client on the new primary after ${followedAt - killedAt} ms; ${frames.length} frames captured and replayed; ${counts.length} rate-limit checks, slowest ${Math.round(slowest)} ms`,
    );
  }, 90_000);
});
