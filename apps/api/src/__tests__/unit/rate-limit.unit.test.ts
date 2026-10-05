import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sharedRedis: vi.fn().mockResolvedValue(null),
  getRateLimitSettings: vi.fn(),
}));

vi.mock('../../services/chat-streams.js', () => ({
  sharedRedis: mocks.sharedRedis,
  noteRedisFailure: () => undefined,
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getRateLimitSettings: mocks.getRateLimitSettings,
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE: 20,
      RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE: 5,
    }),
  };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { acquireStreamSlot, resetLocalConcurrency } from '../../services/limits/concurrency.js';
import {
  authRateLimit,
  consumeRateLimit,
  refundRateLimit,
  resetLocalRateLimits,
} from '../../services/limits/rate-limit.js';

beforeEach(() => {
  resetLocalRateLimits();
  resetLocalConcurrency();
  mocks.sharedRedis.mockResolvedValue(null);
  mocks.getRateLimitSettings.mockResolvedValue({
    roles: {
      admin: { maxConcurrentStreams: 10, chatRequestsPerMinute: 120, uploadRequestsPerMinute: 120 },
      user: { maxConcurrentStreams: 3, chatRequestsPerMinute: 30, uploadRequestsPerMinute: 20 },
      restricted: {
        maxConcurrentStreams: 1,
        chatRequestsPerMinute: 10,
        uploadRequestsPerMinute: 5,
      },
    },
    authAttemptsPerMinute: 10,
  });
});

describe('rate limiting', () => {
  it('allows requests up to the limit and refuses the next', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await consumeRateLimit({ bucket: 'chat', identifier: 'user-1', limit: 3 });
      expect(result.allowed).toBe(true);
    }

    const exceeded = await consumeRateLimit({ bucket: 'chat', identifier: 'user-1', limit: 3 });
    expect(exceeded.allowed).toBe(false);
    expect(exceeded.remaining).toBe(0);
    // The client needs to know when retrying is worthwhile.
    expect(exceeded.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each identifier separately', async () => {
    await consumeRateLimit({ bucket: 'chat', identifier: 'user-1', limit: 1 });
    const other = await consumeRateLimit({ bucket: 'chat', identifier: 'user-2', limit: 1 });
    expect(other.allowed).toBe(true);
  });

  it('keeps buckets independent so uploads do not consume the chat budget', async () => {
    await consumeRateLimit({ bucket: 'chat', identifier: 'user-1', limit: 1 });
    const upload = await consumeRateLimit({ bucket: 'upload', identifier: 'user-1', limit: 1 });
    expect(upload.allowed).toBe(true);
  });

  it('limits authentication by IP even when the account differs', async () => {
    // An attacker controls the account field, so an account-only limit would
    // be evaded by varying it. The address allows far more than an account
    // (RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE, here 20), for people behind a NAT.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await authRateLimit({ ipAddress: '198.51.100.7', identifier: `victim-${attempt}@x.test` });
    }

    const blocked = await authRateLimit({
      ipAddress: '198.51.100.7',
      identifier: 'someone-new@x.test',
    });
    expect(blocked.allowed).toBe(false);
  });

  it('limits authentication by account even when the IP rotates', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await authRateLimit({ ipAddress: `203.0.113.${attempt}`, identifier: 'victim@x.test' });
    }

    const blocked = await authRateLimit({ ipAddress: '203.0.113.99', identifier: 'victim@x.test' });
    expect(blocked.allowed).toBe(false);
  });
});

describe('authentication limit details', () => {
  it('marks only the first refusal in a window, so it is recorded once', async () => {
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1)
      results.push(await consumeRateLimit({ bucket: 'auth:ip', identifier: 'a', limit: 2 }));
    expect(results.map((result) => [result.allowed, result.firstRefusal])).toEqual([
      [true, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it('names the limit that refused, and counts nothing without an address or account', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1)
      await authRateLimit({ ipAddress: `192.0.2.${attempt}`, identifier: 'Victim@X.test' });
    expect(
      await authRateLimit({ ipAddress: '192.0.2.200', identifier: ' victim@x.test ' }),
    ).toMatchObject({ allowed: false, scope: 'account' });
    expect(await authRateLimit({ ipAddress: null, identifier: null })).toMatchObject({
      allowed: true,
      scope: null,
    });
  });
});

describe('sign-in storms (v0.11)', () => {
  const credential = (ip: string | null, identifier: string) =>
    authRateLimit({ kind: 'credential', ipAddress: ip, identifier });

  it('refunds a successful sign-in, so only failures count per account and address', async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await credential('198.51.100.1', 'student@x.test');
      expect(result.allowed).toBe(true);
      expect(result.refundOnSuccess).toHaveLength(2);
      for (const key of result.refundOnSuccess) await refundRateLimit(key);
    }
  });

  it('refuses the eleventh failure for one account and names the account', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await credential('198.51.100.2', 'victim@x.test')).allowed).toBe(true);
    expect(await credential('198.51.100.2', 'victim@x.test')).toMatchObject({
      allowed: false,
      scope: 'account',
      refundOnSuccess: [],
    });
  });

  it('stops at the first refusal, so a locked account does not use up its address', async () => {
    for (let attempt = 0; attempt < 15; attempt += 1)
      await credential('198.51.100.3', 'locked@x.test');
    // Ten failures counted for the address, not fifteen: ten more fit.
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await credential('198.51.100.3', `other-${attempt}@x.test`)).allowed).toBe(true);
    expect(await credential('198.51.100.3', 'one-more@x.test')).toMatchObject({
      allowed: false,
      scope: 'ip',
    });
  });

  it('caps every request from an address at ten times its allowance', async () => {
    let refused = null;
    for (let attempt = 0; attempt < 201 && !refused; attempt += 1) {
      const result = await authRateLimit({ kind: 'sso-start', ipAddress: '198.51.100.4' });
      if (!result.allowed) refused = { attempt, scope: result.scope };
    }
    expect(refused).toEqual({ attempt: 200, scope: 'ip-ceiling' });
  });

  it('budgets single sign-on callbacks per identity provider', async () => {
    const callback = (provider: string, ip: string) =>
      authRateLimit({ kind: 'sso-callback', ipAddress: ip, provider });
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await callback('flaky', `203.0.113.${attempt}`)).allowed).toBe(true);
    expect(await callback('flaky', '203.0.113.50')).toMatchObject({
      allowed: false,
      scope: 'provider',
    });
    // Another provider is unaffected.
    expect((await callback('campus', '203.0.113.50')).allowed).toBe(true);
  });

  it('counts password and email changes per session', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1)
      await authRateLimit({ kind: 'session', ipAddress: null, session: 'abc' });
    expect(await authRateLimit({ kind: 'session', ipAddress: null, session: 'abc' })).toMatchObject(
      { allowed: false, scope: 'session' },
    );
    expect(
      (await authRateLimit({ kind: 'session', ipAddress: null, session: 'other' })).allowed,
    ).toBe(true);
  });

  it('never refunds below zero', async () => {
    const first = await consumeRateLimit({ bucket: 'refund', identifier: 'x', limit: 1 });
    await refundRateLimit(first.key!);
    await refundRateLimit(first.key!);
    expect((await consumeRateLimit({ bucket: 'refund', identifier: 'x', limit: 1 })).allowed).toBe(
      true,
    );
    expect((await consumeRateLimit({ bucket: 'refund', identifier: 'x', limit: 1 })).allowed).toBe(
      false,
    );
  });
});

describe('concurrency cap', () => {
  it('permits up to the role limit of simultaneous generations', async () => {
    const first = await acquireStreamSlot('user-1', 'user', 'run-1');
    const second = await acquireStreamSlot('user-1', 'user', 'run-2');
    const third = await acquireStreamSlot('user-1', 'user', 'run-3');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
  });

  it('refuses a run past the cap', async () => {
    for (const runId of ['run-1', 'run-2', 'run-3']) {
      await acquireStreamSlot('user-1', 'user', runId);
    }

    expect(await acquireStreamSlot('user-1', 'user', 'run-4')).toBeNull();
  });

  it('frees the slot when a generation ends', async () => {
    const slots = [];
    for (const runId of ['run-1', 'run-2', 'run-3']) {
      slots.push(await acquireStreamSlot('user-1', 'user', runId));
    }
    expect(await acquireStreamSlot('user-1', 'user', 'run-4')).toBeNull();

    await slots[0]?.release();
    expect(await acquireStreamSlot('user-1', 'user', 'run-4')).not.toBeNull();
  });

  it('applies each role its own cap rather than a shared one', async () => {
    await acquireStreamSlot('user-2', 'restricted', 'run-1');
    expect(await acquireStreamSlot('user-2', 'restricted', 'run-2')).toBeNull();

    // A different user is unaffected by someone else reaching their cap.
    expect(await acquireStreamSlot('user-3', 'restricted', 'run-3')).not.toBeNull();
  });
});
