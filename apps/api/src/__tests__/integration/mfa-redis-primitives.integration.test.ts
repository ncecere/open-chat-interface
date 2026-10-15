import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The Redis primitive OCI's TOTP replay guard stands on (SPEC-mfa.md, "Replay"):
 * one atomic `SET key value EX seconds NX` records a used code and answers
 * whether it was new, so two replicas racing on the same code cannot both
 * accept it, and the record expires on its own. Run against the real server.
 */
const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
await redis.connect();
const prefix = `test-mfa-primitives:${crypto.randomUUID()}`;

afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

describe('integration: Redis SET NX EX', () => {
  it('answers OK once and null after, with the expiry set', async () => {
    const key = `${prefix}:once`;
    expect(await redis.set(key, '1', 'EX', 120, 'NX')).toBe('OK');
    expect(await redis.set(key, '1', 'EX', 120, 'NX')).toBeNull();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('lets exactly one of many concurrent attempts win', async () => {
    const key = `${prefix}:race`;
    const results = await Promise.all(
      Array.from({ length: 25 }, () => redis.set(key, '1', 'EX', 120, 'NX')),
    );
    expect(results.filter((result) => result === 'OK')).toHaveLength(1);
  });

  it('forgets the record when it expires', async () => {
    const key = `${prefix}:expires`;
    expect(await redis.set(key, '1', 'EX', 1, 'NX')).toBe('OK');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await redis.set(key, '1', 'EX', 1, 'NX')).toBe('OK');
  });
});
