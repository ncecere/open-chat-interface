import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Redis is required for more than one replica (v0.11 design, item 16): System
 * health and each replica's log say so when several replicas share the
 * database without it.
 */
const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  replicas: 1 as number | null,
  client: null as { ping: () => Promise<string> } | null,
  live: [] as unknown[] | null,
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../config/env.js', () => ({ loadEnv: () => mocks.env }));
vi.mock('../../db/replicas.js', () => ({ databaseReplicaCount: async () => mocks.replicas }));
vi.mock('../../services/chat-streams.js', () => ({
  redisConfigured: () =>
    Boolean(mocks.env.REDIS_URL || mocks.env.REDIS_SENTINELS || mocks.env.REDIS_CLUSTER_NODES),
  sharedRedisClient: async () => mocks.client,
}));
vi.mock('../../services/jobs/workers.js', () => ({ liveReplicas: async () => mocks.live }));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() },
}));

import { redisHealthCheck, watchRedisRequirement } from '../../lib/redis-requirement.js';

beforeEach(() => {
  mocks.env = {};
  mocks.replicas = 1;
  mocks.client = null;
  mocks.live = [];
  mocks.warn.mockReset();
  mocks.error.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('Redis requirement', () => {
  it('warns without Redis for one replica, and errors for several', async () => {
    expect(await redisHealthCheck()).toMatchObject({ status: 'warn' });
    mocks.replicas = null;
    expect(await redisHealthCheck()).toMatchObject({ status: 'warn' });
    mocks.replicas = 3;
    expect(await redisHealthCheck()).toMatchObject({
      status: 'error',
      detail: expect.stringMatching(/^3 replicas share this database .*required/),
    });
  });

  it('reports a configured Redis that does not answer, by mode', async () => {
    mocks.env = { REDIS_SENTINELS: 's1:26379', REDIS_SENTINEL_NAME: 'oci' };
    expect(await redisHealthCheck()).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Sentinel, master "oci"'),
    });
    mocks.env = { REDIS_CLUSTER_NODES: 'c1:6379' };
    mocks.client = { ping: async () => Promise.reject(new Error('down')) };
    expect(await redisHealthCheck()).toMatchObject({
      status: 'error',
      detail: 'Configured (Redis Cluster) but not reachable',
    });
  });

  it('is ok when Redis answers, with the replicas it lists', async () => {
    mocks.env = { REDIS_URL: 'redis://r' };
    mocks.client = { ping: async () => 'PONG' };
    mocks.live = [{}, {}];
    expect(await redisHealthCheck()).toEqual({
      id: 'redis',
      label: 'Redis',
      status: 'ok',
      detail: 'Responding (one server; 2 replicas)',
    });
    mocks.live = null;
    expect((await redisHealthCheck()).detail).toBe('Responding (one server)');
  });

  it('logs a warning at startup and while several replicas run without Redis', async () => {
    vi.useFakeTimers();
    mocks.replicas = 2;
    const stop = watchRedisRequirement({ firstCheckMs: 10, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.warn).toHaveBeenCalledWith({ replicas: 2 }, expect.stringContaining('required'));
    mocks.replicas = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.warn).toHaveBeenCalledOnce();
    stop();
    // With Redis configured there is nothing to watch.
    mocks.env = { REDIS_URL: 'redis://r' };
    watchRedisRequirement()();
  });
});
