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
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { acquireStreamSlot, resetLocalConcurrency } from '../../services/limits/concurrency.js';
import {
  authRateLimit,
  consumeRateLimit,
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
    // be evaded by varying it.
    for (let attempt = 0; attempt < 10; attempt += 1) {
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
