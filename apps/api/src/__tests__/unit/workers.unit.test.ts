import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'web' as 'web' | 'worker' | 'all',
  redis: null as null | Record<string, unknown>,
  lastSweep: null as Date | null,
  sweepFails: false,
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/role.js', () => ({
  runsBackgroundJobs: () => mocks.role !== 'web',
  processRole: () => mocks.role,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/chat-streams.js', () => ({ sharedRedis: async () => mocks.redis }));
vi.mock('../../db/index.js', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (mocks.sweepFails) throw new Error('database down');
      return mocks.lastSweep ? [{ startedAt: mocks.lastSweep }] : [];
    },
  };
  return { db: chain };
});

import {
  jobsOnWorkers,
  liveReplicas,
  NO_WORKER_MESSAGE,
  replicaHeartbeat,
  startReplicaHeartbeat,
  watchForWorkers,
  workerStatus,
  workersHealthCheck,
} from '../../services/jobs/workers.js';

/** Just enough of ioredis for the heartbeat: a sorted set and string keys. */
function fakeRedis() {
  const scores = new Map<string, number>();
  const values = new Map<string, string>();
  const multi = () => {
    const ops: Array<() => void> = [];
    const chain = {
      zadd: (_key: string, score: number, member: string) => {
        ops.push(() => scores.set(member, score));
        return chain;
      },
      set: (key: string, value: string) => {
        ops.push(() => values.set(key, value));
        return chain;
      },
      zremrangebyscore: (_key: string, _min: string, max: number) => {
        ops.push(() => {
          for (const [member, score] of scores) if (score <= max) scores.delete(member);
        });
        return chain;
      },
      zrem: (_key: string, member: string) => {
        ops.push(() => scores.delete(member));
        return chain;
      },
      del: (key: string) => {
        ops.push(() => values.delete(key));
        return chain;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
    return chain;
  };
  return {
    scores,
    values,
    multi,
    zrangebyscore: async (_key: string, min: number) =>
      [...scores].filter(([, score]) => score >= min).map(([member]) => member),
    mget: async (keys: string[]) => keys.map((key) => values.get(key) ?? null),
  };
}

beforeEach(() => {
  mocks.role = 'web';
  mocks.redis = null;
  mocks.lastSweep = null;
  mocks.sweepFails = false;
  mocks.warn.mockReset();
  mocks.info.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('replica heartbeats (v0.11 worker role)', () => {
  it('lists replicas while they beat and forgets one at once when it stops', async () => {
    const redis = fakeRedis();
    mocks.redis = redis;
    const stop = startReplicaHeartbeat('worker');
    await vi.waitFor(async () => expect(await liveReplicas()).toHaveLength(1));
    // Another replica, and one whose details expired, and one unreadable.
    redis.scores.set('other', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:other',
      JSON.stringify({ id: 'other', role: 'web', host: 'b' }),
    );
    redis.scores.set('expired', Date.now());
    redis.scores.set('garbled', Date.now());
    redis.values.set('oci:{replicas}:replica:garbled', '{');
    const replicas = await liveReplicas();
    expect(replicas?.map((replica) => replica.role)).toEqual(['web', 'worker']);
    expect(replicas?.[1]).toMatchObject({ role: 'worker', version: expect.any(String) });
    await stop();
    expect((await liveReplicas())?.map((replica) => replica.id)).toEqual(['other']);
  });

  it('beats on its interval, and does nothing without Redis', async () => {
    vi.useFakeTimers();
    const stop = startReplicaHeartbeat('all');
    expect(await liveReplicas()).toBeNull();
    const redis = fakeRedis();
    mocks.redis = redis;
    await vi.advanceTimersByTimeAsync(replicaHeartbeat.intervalMs);
    expect(redis.scores.size).toBe(1);
    await stop();
    expect(redis.scores.size).toBe(0);
    mocks.redis = {
      multi: () => ({
        zadd: () => {
          throw new Error('down');
        },
      }),
    };
    // A failing heartbeat is logged at debug level only and never throws.
    const failing = startReplicaHeartbeat('all');
    await vi.advanceTimersByTimeAsync(replicaHeartbeat.intervalMs);
    mocks.redis = null;
    await failing();
  });
});

describe('the jobs the workers run (#256)', () => {
  it('comes from the heartbeats of replicas that run jobs, or is unknown', async () => {
    const redis = fakeRedis();
    mocks.redis = redis;
    expect(await jobsOnWorkers()).toBeNull();
    // A web replica's heartbeat leaves its list out: it runs no jobs.
    const web = startReplicaHeartbeat('web', [{ name: 'web.only', intervalMs: 1 }]);
    await vi.waitFor(async () => expect(await liveReplicas()).toHaveLength(1));
    expect((await liveReplicas())?.[0]?.jobs).toBeUndefined();
    await web();
    const worker = startReplicaHeartbeat('worker', [
      { name: 'storage.recompute-usage', intervalMs: 86_400_000 },
    ]);
    await vi.waitFor(async () => expect(await liveReplicas()).toHaveLength(1));
    expect(await jobsOnWorkers()).toEqual([
      { name: 'storage.recompute-usage', intervalMs: 86_400_000 },
    ]);
    // A worker too old to say makes the list unknown, not partial.
    redis.scores.set('old', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:old',
      JSON.stringify({ id: 'old', role: 'all', host: 'c' }),
    );
    expect(await jobsOnWorkers()).toBeNull();
    await worker();
  });
});

describe('whether any replica runs background jobs', () => {
  it('is this replica, when it runs them', async () => {
    mocks.role = 'all';
    expect(await workerStatus()).toMatchObject({ alive: true, evidence: 'this-replica' });
    expect(await workersHealthCheck()).toMatchObject({
      status: 'ok',
      detail: 'This replica (OCI_ROLE=all) runs background jobs.',
    });
  });

  it('is a worker heartbeat, when Redis has one', async () => {
    const redis = fakeRedis();
    mocks.redis = redis;
    redis.scores.set('w', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:w',
      JSON.stringify({ id: 'w', role: 'worker', host: 'w' }),
    );
    redis.scores.set('v', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:v',
      JSON.stringify({ id: 'v', role: 'web', host: 'v' }),
    );
    expect(await workerStatus()).toMatchObject({ alive: true, evidence: 'heartbeat' });
    expect((await workersHealthCheck()).detail).toBe(
      'Background jobs run on another replica. Replicas seen in the last minute: 1 web, 1 worker.',
    );
  });

  it('is a recent run of the sweep, without Redis', async () => {
    mocks.lastSweep = new Date(Date.now() - 5_000);
    expect(await workerStatus()).toMatchObject({ alive: true, evidence: 'job-runs' });
    expect((await workersHealthCheck()).detail).toMatch(/ran in the last minute/);
  });

  it('warns, rather than blaming Redis, when Redis is up but no worker is beating', async () => {
    // What the QA walk saw right after stopping the worker (#119).
    const redis = fakeRedis();
    mocks.redis = redis;
    redis.scores.set('v', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:v',
      JSON.stringify({ id: 'v', role: 'web', host: 'v' }),
    );
    mocks.lastSweep = new Date(Date.now() - 5_000);
    const check = await workersHealthCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('no worker has checked in: one may have just stopped');
    expect(check.detail).not.toContain('no Redis');
  });

  it('is nothing: web replicas only, no recent run', async () => {
    const redis = fakeRedis();
    mocks.redis = redis;
    redis.scores.set('v', Date.now());
    redis.values.set(
      'oci:{replicas}:replica:v',
      JSON.stringify({ id: 'v', role: 'web', host: 'v' }),
    );
    mocks.lastSweep = new Date(Date.now() - 10 * 60_000);
    expect(await workerStatus()).toMatchObject({ alive: false, evidence: 'none' });
    expect(await workersHealthCheck()).toEqual({
      id: 'workers',
      label: 'Background workers',
      status: 'error',
      detail: NO_WORKER_MESSAGE,
    });
    mocks.sweepFails = true;
    expect(await workerStatus()).toMatchObject({ alive: false, lastJobRunAt: null });
  });

  it('warns in the log of a web replica while no worker runs, and says when one is back', async () => {
    vi.useFakeTimers();
    const stop = watchForWorkers({ firstCheckMs: 1_000, intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'web' }),
      NO_WORKER_MESSAGE,
    );
    // Not every minute: every ten while it lasts.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    mocks.lastSweep = new Date();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.info).toHaveBeenCalledWith(
      { evidence: 'job-runs' },
      'A background worker is running again',
    );
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
