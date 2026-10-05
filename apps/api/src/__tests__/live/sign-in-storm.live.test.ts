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
 * Sign-in storms (v0.11 design, item 22): a campus behind one NAT address on
 * a term's first morning.
 *
 * Better Auth's own limiter runs only when NODE_ENV is production, so this
 * file runs as production. Reproduced first on v0.11 before the fix: of 50
 * people signing in from one address within ten seconds, 3 succeeded, 7 were
 * refused by Better Auth's limiter (three per address per ten seconds, in the
 * memory of one replica) and 40 by OCI's own (ten per address per minute).
 * Now Better Auth's limiter is off and OCI's limits, shared in Redis, count
 * failed attempts per account and per address (with a far larger allowance
 * per address) and every request from an address only against a high ceiling.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const PASSWORD = 'storm-password-123456';
const state = vi.hoisted(() => {
  const previousNodeEnv = process.env.NODE_ENV;
  // Before anything imports Better Auth, which reads NODE_ENV once at load.
  process.env.NODE_ENV = 'production';
  return {
    db: null as unknown,
    organizationId: '',
    previousNodeEnv,
    env: {} as Record<string, string>,
  };
});
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
      // The defaults these tests assert, whatever the environment says (CI
      // raises RATE_LIMIT_AUTH_PER_MINUTE so browser tests are not throttled).
      RATE_LIMIT_AUTH_PER_MINUTE: 10,
      RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE: 300,
      RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE: 3_000,
      ...state.env,
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

/** A documentation address unique to this run, so Redis counters never collide. */
const address = () =>
  `2001:db8:${randomInt(0xffff).toString(16)}::${randomInt(0xffff).toString(16)}`;

/** Counters use one-minute windows; start each run with room left in the current one. */
async function freshWindow(room = 20_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < room) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

type Outcome = 'ok' | 'oci-429' | 'better-auth-429' | 'other';

describe.skipIf(!available)('live: sign-in storm from one address', { timeout: 120_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let redis: Redis;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';
  const people: string[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('sign_in_storm');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { auth } = await import('../../auth/index.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api', createApiRoutes());
    redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    // Accounts made directly, not through the limited HTTP route.
    for (let index = 0; index < 51; index++) {
      const email = `storm-${index}-${randomUUID().slice(0, 8)}@campus.test`;
      await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: `Student ${index}` } });
      people.push(email);
    }
  });

  afterAll(async () => {
    process.env.NODE_ENV = state.previousNodeEnv;
    redis?.disconnect();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function signIn(email: string, ip: string, password = PASSWORD) {
    return app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    });
  }

  async function outcome(response: Response): Promise<Outcome> {
    if (response.status === 200) return 'ok';
    if (response.status !== 429) return 'other';
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code === 'RATE_LIMITED' ? 'oci-429' : 'better-auth-429';
  }

  function tally(outcomes: Outcome[]) {
    const counts: Record<Outcome, number> = {
      ok: 0,
      'oci-429': 0,
      'better-auth-429': 0,
      other: 0,
    };
    for (const entry of outcomes) counts[entry] += 1;
    return counts;
  }

  it('lets 50 people behind one address sign in within ten seconds', async () => {
    const nat = address();
    await freshWindow();
    const started = Date.now();
    const outcomes: Outcome[] = [];
    // Ten at a time, as browsers on a campus network would arrive.
    for (let offset = 0; offset < 50; offset += 10) {
      const batch = people.slice(offset, offset + 10);
      outcomes.push(
        ...(await Promise.all(batch.map(async (email) => outcome(await signIn(email, nat))))),
      );
    }
    const elapsed = Date.now() - started;
    const counts = tally(outcomes);
    console.info('Sign-in storm from one address', { ...counts, elapsedMs: elapsed });
    expect(elapsed).toBeLessThan(10_000);
    expect(counts).toEqual({ ok: 50, 'oci-429': 0, 'better-auth-429': 0, other: 0 });
  });

  it('still refuses brute force against one account from that address', async () => {
    const nat = address();
    const target = people[50]!;
    await freshWindow();
    // The default allowance: ten failed attempts per account per minute.
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await signIn(target, nat, 'wrong-password-0000')).status).toBe(401);
    const refused = await signIn(target, nat, 'wrong-password-0000');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // Locked for the rest of the window, even with the right password.
    expect((await signIn(target, nat)).status).toBe(429);
    // Others behind the same address are unaffected.
    expect((await signIn(people[0]!, nat)).status).toBe(200);

    const [entry] = await pool.db.execute<{ metadata: Record<string, unknown> }>(
      sql`select metadata from audit_log where action = 'auth.rate_limited' and actor_email = ${target}`,
    );
    expect(entry?.metadata).toMatchObject({ scope: 'account', path: '/sign-in/email', limit: 10 });

    // Counted in Redis, so every replica shares the count.
    const keys = await redis.keys(`oci:limit:auth:account-failed:${target}:*`);
    expect(keys).toHaveLength(1);
  });

  it('does not count successful sign-ins against the account', async () => {
    const nat = address();
    await freshWindow();
    for (let attempt = 0; attempt < 15; attempt++)
      expect((await signIn(people[1]!, nat)).status).toBe(200);
  });
});
