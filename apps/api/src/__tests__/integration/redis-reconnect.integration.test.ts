import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Redis dropping the API's connection in the middle of a reply (v0.11 design,
 * item 16): what a Sentinel or Cluster failover, a Redis restart or a proxy
 * closing connections does. Only this test's own connection is closed
 * (`CLIENT KILL ID`), so the shared test server is not disturbed.
 *
 * Reproduced first: the reply's capture gave up at the first failed append
 * (its live replay marked unavailable), the reader following it ended with
 * "Live replay is no longer available", and Redis was not used again for 30
 * seconds, so rate limits counted per replica meanwhile. Now the client
 * reconnects at once, the frames that could not be stored are stored, and
 * the reader finishes with the whole reply.
 */
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
    CHAT_STREAM_TTL_SECONDS: 60,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
}));

const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
async function available() {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const enabled = await available();
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe.skipIf(!enabled)('integration: a dropped Redis connection mid-reply', () => {
  const admin = new Redis(url, { lazyConnect: true });
  admin.on('error', () => {});
  let streams: typeof import('../../services/chat-streams.js');
  let limits: typeof import('../../services/limits/rate-limit.js');
  const keys: string[] = [];

  beforeAll(async () => {
    await admin.connect();
    streams = await import('../../services/chat-streams.js');
    limits = await import('../../services/limits/rate-limit.js');
  });
  afterAll(async () => {
    if (keys.length) await admin.del(...keys);
    await streams?.closeChatStreams();
    admin.disconnect();
  });

  /** Closes the API's shared connection from the server side. */
  async function dropConnection() {
    const client = await streams.sharedRedis();
    const id = await client!.client('ID');
    expect(await admin.client('KILL', 'ID', String(id))).toBe(1);
  }

  it('finishes the capture and its reader, and uses Redis again at once', async () => {
    const id = randomUUID();
    const identity = { runId: `run-${id}`, threadId: `thread-${id}`, userId: `user-${id}` };
    keys.push(
      `oci:chat-stream:run:${identity.runId}:metadata`,
      `oci:chat-stream:run:${identity.runId}:events`,
      `oci:chat-stream:thread:${identity.threadId}:active`,
    );
    expect(await streams.beginChatRun(identity)).toBe('available');
    const frames = [
      sse({ type: 'start' }),
      sse({ type: 'text-start', id: 't' }),
      ...Array.from({ length: 80 }, (_, n) => sse({ type: 'text-delta', id: 't', delta: `${n} ` })),
      sse({ type: 'text-end', id: 't' }),
      sse({ type: 'finish' }),
    ];
    let sent = 0;
    const capture = streams.captureChatRun(
      identity,
      new ReadableStream<string>({
        async pull(controller) {
          if (sent === frames.length) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.enqueue(frames[sent++]!);
        },
      }),
      () => ({ status: 'complete' }),
    );
    await vi.waitFor(() => expect(sent).toBeGreaterThan(10), { interval: 5 });
    const resumed = await streams.resumeActiveChatRun(identity.threadId, identity.userId);
    const reading = new Response(resumed!.stream).text();

    await vi.waitFor(() => expect(sent).toBeGreaterThan(40), { interval: 5 });
    await dropConnection();
    const droppedAt = Date.now();
    await vi.waitFor(async () => expect(await streams.sharedRedis()).not.toBeNull(), {
      timeout: 5_000,
      interval: 20,
    });
    // Back within moments, not after a 30-second pause.
    expect(Date.now() - droppedAt).toBeLessThan(3_000);

    await capture;
    expect(await reading).toBe(frames.join(''));
    expect(await admin.hgetall(`oci:chat-stream:run:${identity.runId}:metadata`)).toMatchObject({
      status: 'complete',
      lastSequence: String(frames.length),
      replayUnavailable: '0',
    });

    // Rate limits count in Redis again.
    const result = await limits.consumeRateLimit({
      bucket: 'reconnect-test',
      identifier: id,
      limit: 5,
    });
    const key = `oci:limit:reconnect-test:${id}:${Math.floor(Date.now() / 60_000)}`;
    keys.push(key);
    expect(result.remaining).toBe(4);
    expect(await admin.get(key)).toBe('1');
  }, 30_000);

  it('stores again the newest events a failover lost', async () => {
    const id = randomUUID();
    const identity = { runId: `run-${id}`, threadId: `thread-${id}`, userId: `user-${id}` };
    const metadata = `oci:chat-stream:run:${identity.runId}:metadata`;
    const events = `oci:chat-stream:run:${identity.runId}:events`;
    keys.push(metadata, events, `oci:chat-stream:thread:${identity.threadId}:active`);
    expect(await streams.beginChatRun(identity)).toBe('available');
    const frames = Array.from({ length: 30 }, (_, n) =>
      sse({ type: 'text-delta', id: 't', delta: `${n} ` }),
    );
    let sent = 0;
    let lost = false;
    let reading!: Promise<string>;
    const capture = streams.captureChatRun(
      identity,
      new ReadableStream<string>({
        async pull(controller) {
          if (sent === frames.length) return controller.close();
          if (sent === 2 && !reading) {
            const resumed = await streams.resumeActiveChatRun(identity.threadId, identity.userId);
            reading = new Response(resumed!.stream).text();
          }
          if (sent === 20 && !lost) {
            lost = true;
            // Once the first 20 are stored (the stream reads ahead of the capture).
            await vi.waitFor(
              async () => expect(await admin.hget(metadata, 'lastSequence')).toBe('20'),
              {
                interval: 5,
              },
            );
            // And the reader has sent them on.
            await new Promise((resolve) => setTimeout(resolve, 400));
            // What a replica promoted before receiving the newest writes holds:
            // the run as it was five events ago (at once, as a promoted
            // replica's copy is always a consistent prefix).
            await admin.eval(
              `
              local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 5)
              for _, entry in ipairs(last) do redis.call('XDEL', KEYS[2], entry[1]) end
              redis.call('HINCRBY', KEYS[1], 'lastSequence', -#last)
              return #last
            `,
              2,
              metadata,
              events,
            );
            // The reader looks while Redis is behind it, before the next frame
            // makes the producer store the lost ones again.
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          controller.enqueue(frames[sent++]!);
        },
      }),
      () => ({ status: 'complete' }),
    );
    await capture;
    expect(await streams.capturedChatRunFrames(identity.runId)).toEqual(frames);
    // The reader waited for the lost events to be stored again, and sent none twice.
    expect(await reading).toBe(frames.join(''));
    expect(await admin.hget(metadata, 'status')).toBe('complete');
  });
});
