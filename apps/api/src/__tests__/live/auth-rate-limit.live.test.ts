import { randomInt, randomUUID } from 'node:crypto';
import { createDatabase, sql } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * RATE_LIMIT_AUTH_PER_MINUTE (v0.10 fix): configured and shown on People →
 * Roles & access since v0.6, but nothing called the code that applies it, so
 * only Better Auth's own limiter ran (per process, and only in production).
 * Real Better Auth, PostgreSQL and Redis, through the real /api routes.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const LIMIT = 3;
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
      RATE_LIMIT_AUTH_PER_MINUTE: '3',
    }),
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'auth')
      return {
        registrationMode: 'open',
        localAuthEnabled: true,
        emailVerificationRequired: false,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    if (key === 'smtp') return { host: null, port: 25, fromAddress: null };
    return {};
  },
}));

async function redisAvailable() {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = (await livePostgresAvailable()) && (await redisAvailable());

/** A documentation address unique to this test, so Redis counters never collide across runs. */
const address = () =>
  `2001:db8:${randomInt(0xffff).toString(16)}::${randomInt(0xffff).toString(16)}`;
const email = () => `${randomUUID()}@example.test`;

/**
 * Counters live in fixed one-minute windows (`consumeRateLimit`), so a run of
 * attempts that crosses a minute boundary starts again from zero and the
 * attempt meant to be refused is allowed. Each run of attempts starts with at
 * least this much of the current window left, waiting for the next one if not.
 */
const WINDOW_ROOM_MS = 10_000;
async function freshWindow(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < WINDOW_ROOM_MS) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

describe.skipIf(!available)('live: authentication rate limit', { timeout: 30_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let redis: Redis;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('auth_rate_limit');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api', createApiRoutes());
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  });

  afterAll(async () => {
    redis?.disconnect();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function post(path: string, body: Record<string, unknown>, ip: string | null) {
    return app.request(`/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(ip ? { 'x-forwarded-for': ip } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  const signIn = (address: string, ip: string | null) =>
    post('/sign-in/email', { email: address, password: 'not-the-password-123' }, ip);

  async function audits(action: string) {
    return pool.db.execute<{
      actor_email: string | null;
      ip_address: string | null;
      metadata: unknown;
    }>(
      sql`select actor_email, ip_address, metadata from audit_log where action = ${action} order by seq`,
    );
  }

  it('refuses the attempt after the limit from one address with 429 and Retry-After', async () => {
    const ip = address();
    const target = email();
    await freshWindow();

    for (let attempt = 0; attempt < LIMIT; attempt++)
      expect((await signIn(target, ip)).status).toBe(401);

    const refused = await signIn(target, ip);
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Better Auth's client reads the top-level message; the API's clients read `error`.
    expect(await refused.json()).toMatchObject({
      message: expect.stringMatching(/Too many attempts/),
      error: { code: 'RATE_LIMITED' },
    });
    // Refused before Better Auth: no failed sign-in is recorded for it.
    const failures = (await audits('auth.signin.local.failure')).filter(
      (row) => row.actor_email === target,
    );
    expect(failures).toHaveLength(LIMIT);

    // Recorded once per window, however many attempts follow.
    expect((await signIn(target, ip)).status).toBe(429);
    const limited = (await audits('auth.rate_limited')).filter((row) => row.ip_address === ip);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ actor_email: target });
    expect(limited[0]!.metadata).toMatchObject({ path: '/sign-in/email', limit: LIMIT });

    // Counted in Redis, so every replica shares it.
    const keys = await redis.keys(`oci:limit:auth:ip:${ip}:*`);
    expect(keys).toHaveLength(1);
    expect(Number(await redis.get(keys[0]!))).toBeGreaterThan(LIMIT);
  });

  it('limits one account tried from many addresses', async () => {
    const target = email();
    await freshWindow();

    for (let attempt = 0; attempt < LIMIT; attempt++)
      expect((await signIn(target.toUpperCase(), address())).status).toBe(401);
    const refused = await signIn(target, address());
    expect(refused.status).toBe(429);
    const [entry] = (await audits('auth.rate_limited')).filter((row) => row.actor_email === target);
    expect(entry!.metadata).toMatchObject({ scope: 'account' });
  });

  it('limits one address trying many accounts, keyed by the address the proxy wrote', async () => {
    const ip = address();
    await freshWindow();

    for (let attempt = 0; attempt < LIMIT; attempt++)
      // Whatever the client puts further left in X-Forwarded-For is ignored.
      expect((await signIn(email(), `203.0.113.${attempt}, ${ip}`)).status).toBe(401);
    expect((await signIn(email(), `198.51.100.1, ${ip}`)).status).toBe(429);
    // Another address is unaffected.
    expect((await signIn(email(), address())).status).toBe(401);
  });

  it('covers sign-up, password reset and verification, and nothing else', async () => {
    let ip = '';
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      [
        'sign-up',
        () => post('/sign-up/email', { email: email(), password: 'short', name: 'X' }, ip),
      ],
      ['reset request', () => post('/request-password-reset', { email: email() }, ip)],
      ['reset', () => post('/reset-password', { token: randomUUID(), newPassword: 'x' }, ip)],
      ['verification email', () => post('/send-verification-email', { email: email() }, ip)],
      [
        'verify',
        () =>
          app.request(`/api/auth/verify-email?token=${randomUUID()}`, {
            headers: { origin, 'x-forwarded-for': ip },
          }),
      ],
    ];
    for (const [name, attempt] of cases) {
      ip = address();
      await freshWindow();

      for (let count = 0; count < LIMIT; count++)
        expect((await attempt()).status, name).not.toBe(429);
      expect((await attempt()).status, name).toBe(429);
    }

    // Reading the session is not an attempt.
    ip = address();
    await freshWindow();

    for (let count = 0; count <= LIMIT + 1; count++) {
      const response = await app.request('/api/auth/get-session', {
        headers: { origin, 'x-forwarded-for': ip },
      });
      expect(response.status).not.toBe(429);
    }
  });

  it('without a client address, counts the account and never one shared bucket', async () => {
    // No proxy header and no socket: one shared "unknown" counter would let a
    // single client lock everyone out, so only the account is counted.
    await freshWindow();

    for (let count = 0; count <= LIMIT + 1; count++)
      expect((await signIn(email(), null)).status).toBe(401);
    const target = email();
    await freshWindow();

    for (let count = 0; count < LIMIT; count++)
      expect((await signIn(target, null)).status).toBe(401);
    expect((await signIn(target, null)).status).toBe(429);
  });

  it("leaves account deletion to the dashboard's audited route", async () => {
    // Better Auth's admin endpoint would skip the deletion event and the
    // last-administrator check (the legal hold trigger applies everywhere).
    const response = await post('/admin/remove-user', { userId: randomUUID() }, address());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: expect.stringMatching(/People/) });
  });
});
