import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sharedRedis: vi.fn(), warn: vi.fn() }));
vi.mock('../../services/chat-streams.js', () => ({
  sharedRedis: mocks.sharedRedis,
  noteRedisFailure: () => undefined,
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getRateLimitSettings: async () => ({
    roles: {
      admin: { maxConcurrentStreams: 10 },
      user: { maxConcurrentStreams: 3 },
      restricted: { maxConcurrentStreams: 1 },
    },
  }),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: mocks.warn } }));

import { acquireStreamSlot } from '../../services/limits/concurrency.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';

function createClient(): Redis {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 1000,
  });
  // The availability probe handles connection errors explicitly below.
  client.on('error', () => undefined);
  return client;
}

const probe = createClient();
let available = false;
try {
  await probe.connect();
  await probe.ping();
  available = true;
} catch {
  console.warn(
    'Skipping stream-slot Redis integration tests: Redis unavailable; set TEST_REDIS_URL or start Redis on port 6389.',
  );
} finally {
  probe.disconnect();
}

describe.skipIf(!available)('integration: atomic stream slots across Redis connections', () => {
  const clients: Redis[] = [];
  const keys = new Set<string>();
  let nextClient = 0;

  function identity() {
    const userId = `test-stream-slots-${randomUUID()}`;
    const key = `oci:concurrency:user:${userId}`;
    keys.add(key);
    return { userId, key };
  }

  function client(): Redis {
    const redis = clients[0];
    if (!redis) throw new Error('Redis clients not initialized');
    return redis;
  }

  beforeAll(async () => {
    for (let index = 0; index < 12; index += 1) clients.push(createClient());
    await Promise.all(clients.map((redis) => redis.connect()));
  });

  beforeEach(() => {
    mocks.sharedRedis.mockImplementation(async () => clients[nextClient++ % clients.length]);
  });

  afterAll(async () => {
    try {
      // Never flush a database or delete keys belonging to another test run.
      if (keys.size > 0) await client().del(...keys);
    } finally {
      for (const redis of clients) redis.disconnect();
    }
  });

  it.each([
    ['restricted', 1],
    ['user', 3],
    ['admin', 10],
  ] as const)('never exceeds the %s role cap under simultaneous acquisition', async (role, cap) => {
    for (let round = 0; round < 5; round += 1) {
      const { userId, key } = identity();
      const results = await Promise.all(
        Array.from({ length: 96 }, (_, index) => acquireStreamSlot(userId, role, `run-${index}`)),
      );
      expect(results.filter((slot) => slot !== null)).toHaveLength(cap);
      expect(await client().zcard(key)).toBe(cap);
      expect(mocks.warn).not.toHaveBeenCalled();
      const ttl = await client().ttl(key);
      expect(ttl).toBeGreaterThan(1790);
      expect(ttl).toBeLessThanOrEqual(1800);
      await Promise.all(results.map((slot) => slot?.release()));
      expect(await client().zcard(key)).toBe(0);
    }
  });

  it('retries an existing run at the cap without consuming another slot', async () => {
    const { userId, key } = identity();
    const first = await acquireStreamSlot(userId, 'restricted', 'same-run');
    expect(first).not.toBeNull();
    const retries = await Promise.all(
      Array.from({ length: 24 }, () => acquireStreamSlot(userId, 'restricted', 'same-run')),
    );
    expect(retries.every((slot) => slot !== null)).toBe(true);
    expect(await client().zcard(key)).toBe(1);
    expect(await acquireStreamSlot(userId, 'restricted', 'another-run')).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('prunes expired members before checking the cap and preserves live members', async () => {
    const { userId, key } = identity();
    const now = Date.now();
    await client().zadd(
      key,
      String(now - 1000),
      'expired-1',
      String(now),
      'expired-2',
      String(now + 60_000),
      'live',
    );
    const before = Date.now();
    expect(await acquireStreamSlot(userId, 'user', 'new-1')).not.toBeNull();
    expect(await client().zrange(key, '0', '-1')).toEqual(['live', 'new-1']);
    const expiresAt = Number(await client().zscore(key, 'new-1'));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(await acquireStreamSlot(userId, 'user', 'new-2')).not.toBeNull();
    expect(await acquireStreamSlot(userId, 'user', 'new-3')).toBeNull();
    expect(await client().zcard(key)).toBe(3);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('releases idempotently and admits exactly one replacement across connections', async () => {
    const { userId, key } = identity();
    const first = await acquireStreamSlot(userId, 'restricted', 'first');
    expect(first).not.toBeNull();
    expect(await acquireStreamSlot(userId, 'restricted', 'blocked')).toBeNull();
    await first?.release();
    await first?.release();
    const replacements = await Promise.all(
      Array.from({ length: 48 }, (_, index) =>
        acquireStreamSlot(userId, 'restricted', `replacement-${index}`),
      ),
    );
    expect(replacements.filter((slot) => slot !== null)).toHaveLength(1);
    await first?.release();
    expect(await client().zcard(key)).toBe(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
