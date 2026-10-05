import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dockerAvailable } from '../../../test/pgbouncer.js';
import { type RedisClusterSet, startRedisCluster } from '../../../test/redis-ha.js';

/**
 * Every Redis use of the API on a real Redis Cluster (v0.11 design, item 16):
 * three primaries, so a reply's run and its thread usually hash to different
 * nodes. Scripts and MULTI may only touch keys of one slot there; a reply's
 * keys share its run's hash tag, the thread's pointer has its own, and the
 * two operations that touch both run in two steps. Any key left untagged
 * fails here with CROSSSLOT.
 */
const state = vi.hoisted(() => ({ nodes: '' }));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({
    REDIS_CLUSTER_NODES: state.nodes,
    REDIS_COMMAND_TIMEOUT_MS: 2_000,
    CHAT_STREAM_TTL_SECONDS: 120,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    OCI_ROLE: 'all',
  }),
}));
vi.mock('../../db/index.js', () => ({ db: {}, sql: {} }));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getRateLimitSettings: async () => ({ roles: { user: { maxConcurrentStreams: 2 } } }),
}));

const available = await dockerAvailable();
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe.skipIf(!available)('live Redis Cluster', () => {
  let cluster: RedisClusterSet;
  let streams: typeof import('../../services/chat-streams.js');

  beforeAll(async () => {
    cluster = await startRedisCluster();
    state.nodes = cluster.nodes;
    streams = await import('../../services/chat-streams.js');
    const client = await streams.sharedRedisClient();
    expect(client?.isCluster).toBe(true);
    // Writes reach every primary before the tests start.
    await vi.waitFor(
      async () => {
        for (let n = 0; n < 12; n++) await client!.set(`oci:test:warm:${n}`, '1', 'PX', 10_000);
      },
      { timeout: 30_000, interval: 250 },
    );
  }, 120_000);
  afterAll(async () => {
    await streams?.closeChatStreams();
    await cluster?.stop();
  });

  function identity() {
    const id = randomUUID();
    return { runId: `run-${id}`, threadId: `thread-${id}`, userId: `user-${id}` };
  }

  async function reply(run: ReturnType<typeof identity>, frames: string[]) {
    return streams.captureChatRun(
      run,
      new ReadableStream<string>({
        async pull(controller) {
          const next = frames.shift();
          if (next === undefined) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(next);
        },
      }),
      () => ({ status: 'complete' }),
    );
  }

  it('captures, replays, cancels and finalizes a reply across slots', async () => {
    const frames = [
      sse({ type: 'start' }),
      ...Array.from({ length: 40 }, (_, n) => sse({ type: 'text-delta', id: 't', delta: `${n}` })),
      sse({ type: 'finish' }),
    ];
    // A turn admitted by PostgreSQL first (the durable path, two steps here).
    const run = identity();
    expect(await streams.beginChatRun(run, { admission: 'durable' })).toBe('available');
    // Publishing it again is idempotent; another run cannot take its place.
    expect(await streams.beginChatRun(run, { admission: 'durable' })).toBe('available');
    expect(
      await streams.beginChatRun(
        { ...identity(), threadId: run.threadId },
        { admission: 'durable' },
      ),
    ).toBe('available');
    expect(await streams.activeChatRunId(run.threadId)).not.toBe(run.runId);

    const second = identity();
    expect(await streams.beginChatRun(second)).toBe('available');
    expect(await streams.beginChatRun({ ...identity(), threadId: second.threadId })).toBe(
      'conflict',
    );
    const capture = reply(second, [...frames]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = await streams.resumeActiveChatRun(second.threadId, second.userId);
    const text = new Response(resumed!.stream).text();
    await streams.touchChatRunHeartbeat(second.runId, 5_000);
    expect(await streams.chatRunProducerActive(second.runId, 5_000)).toBe(true);
    expect(await streams.isChatRunCancellationRequested(second.runId)).toBe(false);
    await capture;
    expect(await text).toBe(frames.join(''));
    expect(await streams.capturedChatRunFrames(second.runId)).toEqual(frames);
    // Finalized: the thread's pointer is gone, the run is complete.
    expect(await streams.activeChatRunId(second.threadId)).toBeNull();
    expect(await streams.resumeActiveChatRun(second.threadId, second.userId)).toBeNull();

    const third = identity();
    expect(await streams.beginChatRun(third)).toBe('available');
    expect(await streams.cancelActiveChatRun(third.threadId, third.userId)).toBe(true);
    expect(await streams.isChatRunCancellationRequested(third.runId)).toBe(true);
    await streams.finalizeInterruptedChatRun(third, 'Interrupted in a test');
    expect(await streams.activeChatRunId(third.threadId)).toBeNull();
  });

  it('counts rate limits and concurrency slots, and lists replicas', async () => {
    const { consumeRateLimit } = await import('../../services/limits/rate-limit.js');
    const id = randomUUID();
    for (let n = 1; n <= 3; n++)
      expect(
        (await consumeRateLimit({ bucket: 'cluster', identifier: id, limit: 10 })).remaining,
      ).toBe(10 - n);

    const { acquireStreamSlot } = await import('../../services/limits/concurrency.js');
    const first = await acquireStreamSlot(id, 'user', 'a');
    const second = await acquireStreamSlot(id, 'user', 'b');
    expect(first && second).toBeTruthy();
    expect(await acquireStreamSlot(id, 'user', 'c')).toBeNull();
    await first!.release();
    expect(await acquireStreamSlot(id, 'user', 'c')).not.toBeNull();

    const workers = await import('../../services/jobs/workers.js');
    const stop = workers.startReplicaHeartbeat('all');
    try {
      await vi.waitFor(async () => expect((await workers.liveReplicas())?.length).toBe(1));
    } finally {
      await stop();
    }
    expect(await workers.liveReplicas()).toEqual([]);

    const { redisHealthCheck } = await import('../../lib/redis-requirement.js');
    expect(await redisHealthCheck()).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('Redis Cluster'),
    });
  });
});
