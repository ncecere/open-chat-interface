import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The TOTP replay guard (SPEC-mfa.md, "Replay"): a code the plugin accepted
 * for a person is refused for 120 seconds, across replicas (Redis, one atomic
 * SET NX EX) and, with Redis away, in this process.
 */
const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
await redis.connect();

const state = vi.hoisted(() => ({
  client: 'real' as 'real' | 'none' | 'broken',
  real: null as unknown,
}));
vi.mock('../../services/chat-streams.js', () => ({
  sharedRedis: async () => {
    if (state.client === 'none') return null;
    if (state.client === 'broken') {
      return {
        set: async () => {
          throw new Error('Redis went away');
        },
        del: async () => {
          throw new Error('Redis went away');
        },
      };
    }
    return state.real;
  },
  noteRedisFailure: () => undefined,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

state.real = redis;
const { claimTotpCode, releaseTotpCode, resetLocalCodeClaims, CODE_REPLAY_SECONDS } = await import(
  '../../services/limits/code-replay.js'
);

const user = `user-${crypto.randomUUID()}`;
const other = `user-${crypto.randomUUID()}`;

beforeEach(() => {
  state.client = 'real';
  resetLocalCodeClaims();
});
afterAll(async () => {
  const keys = await redis.keys('oci:mfa-code:*');
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

describe('integration: TOTP replay guard', () => {
  it('lets a code through once per person, for two minutes', async () => {
    expect(CODE_REPLAY_SECONDS).toBe(120);
    expect(await claimTotpCode(user, '123456')).toBe(true);
    expect(await claimTotpCode(user, '123456')).toBe(false);
    // Another code, and the same digits for another person, are separate.
    expect(await claimTotpCode(user, '654321')).toBe(true);
    expect(await claimTotpCode(other, '123456')).toBe(true);
  });

  it('keeps no code in Redis, only a hash of the person and the code, with an expiry', async () => {
    const code = '246810';
    await claimTotpCode(user, code);
    const keys = await redis.keys('oci:mfa-code:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(code);
      expect(key).not.toContain(user);
      expect(await redis.ttl(key)).toBeGreaterThan(0);
    }
  });

  it('lets exactly one of many concurrent uses of a code win (two replicas, one code)', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claimTotpCode(user, '111222')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('gives a code back when the plugin refused it, so a typing mistake is not a replay', async () => {
    expect(await claimTotpCode(user, '333444')).toBe(true);
    await releaseTotpCode(user, '333444');
    expect(await claimTotpCode(user, '333444')).toBe(true);
  });

  it('counts in this process when Redis is not configured', async () => {
    state.client = 'none';
    expect(await claimTotpCode(user, '555666')).toBe(true);
    expect(await claimTotpCode(user, '555666')).toBe(false);
    await releaseTotpCode(user, '555666');
    expect(await claimTotpCode(user, '555666')).toBe(true);
  });

  it('falls back to this process when Redis fails mid-request, rather than letting a replay through', async () => {
    state.client = 'broken';
    expect(await claimTotpCode(user, '777888')).toBe(true);
    expect(await claimTotpCode(user, '777888')).toBe(false);
    await releaseTotpCode(user, '777888');
    expect(await claimTotpCode(user, '777888')).toBe(true);
  });
});
