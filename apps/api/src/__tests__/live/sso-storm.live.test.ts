import { type ChildProcess, spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
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
 * Single sign-on under a storm (v0.11 design, item 22), through the real
 * Better Auth SSO plugin and the stub OpenID Connect provider the scale
 * harness uses (tools/scale/stub/oidc.mjs):
 *
 * - people behind one address sign in through SSO (just-in-time provisioned)
 *   without meeting any address limit;
 * - failed callbacks from one address are limited per address;
 * - each identity provider has its own budget of callbacks, so one
 *   misbehaving provider is refused while the others keep working.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const ADDRESS_LIMIT = 5;
const PROVIDER_LIMIT = 30;
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', stubOrigin: '' }));
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
      AUTH_TRUSTED_ORIGINS: state.stubOrigin,
      RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE: 5,
      RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE: 30,
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

const address = () =>
  `2001:db8:${randomInt(0xffff).toString(16)}::${randomInt(0xffff).toString(16)}`;

async function freshWindow(room = 30_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < room) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe.skipIf(!available)('live: single sign-on storm', { timeout: 120_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let stub: ChildProcess;
  let issuer = '';
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  async function registerProvider(providerId: string) {
    const config = {
      issuer,
      clientId: 'scale-client',
      clientSecret: 'scale-client-secret',
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      tokenEndpointAuthentication: 'client_secret_basic',
      jwksEndpoint: `${issuer}/jwks`,
      userInfoEndpoint: `${issuer}/userinfo`,
      discoveryEndpoint: `${issuer}/.well-known/openid-configuration`,
      pkce: true,
      scopes: ['openid', 'email', 'profile'],
    };
    await pool.db.execute(sql`
      insert into sso_provider (id, issuer, domain, oidc_config, provider_id, organization_id,
        label, kind, enabled, jit_provisioning, trusted_for_linking, domain_verified, default_role,
        claim_role_mappings)
      values (${providerId}, ${issuer}, 'campus.test', ${JSON.stringify(config)}, ${providerId},
        ${state.organizationId}, ${providerId}, 'oidc', true, true, true, true, 'restricted',
        ${JSON.stringify([{ claim: 'groups', value: 'students', role: 'user' }])}::jsonb)
    `);
  }

  beforeAll(async () => {
    const port = await freePort();
    state.stubOrigin = `http://127.0.0.1:${port}`;
    issuer = `${state.stubOrigin}/oidc`;
    stub = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../../../tools/scale/stub/server.mjs', import.meta.url))],
      {
        env: { ...process.env, STUB_PORT: String(port), STUB_OIDC_ISSUER: issuer },
        stdio: 'ignore',
      },
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      const ok = await fetch(`${state.stubOrigin}/health`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    live = await createLiveDatabase('sso_storm');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    await registerProvider('campus');
    await registerProvider('flaky');
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api', createApiRoutes());
  });

  afterAll(async () => {
    stub?.kill();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const cookieHeader = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

  /** The whole browser round trip; returns OCI's callback response. */
  async function ssoSignIn(providerId: string, email: string, ip: string) {
    const start = await app.request('/api/auth/sign-in/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
      body: JSON.stringify({ providerId, callbackURL: `${origin}/`, loginHint: email }),
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = await fetch(url, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.get('location')!);
    return app.request(`${back.pathname}${back.search}`, {
      headers: { cookie: cookieHeader(start), 'x-forwarded-for': ip },
    });
  }

  const outcome = (response: Response) =>
    response.status === 429
      ? '429'
      : response.status === 302 && !/[?&]error=/.test(response.headers.get('location') ?? '')
        ? 'ok'
        : `failed ${response.status} ${response.headers.get('location') ?? ''}`;

  it('signs in 20 new people behind one address through SSO, provisioned', async () => {
    const nat = address();
    await freshWindow();
    const started = Date.now();
    const people = Array.from(
      { length: 20 },
      (_, index) => `student-${index}-${randomUUID().slice(0, 6)}@campus.test`,
    );
    // Four at a time: a sign-in in flight holds one of the address's failed
    // attempts until it succeeds (here five), so a burst is still bounded.
    const outcomes: string[] = [];
    for (let offset = 0; offset < people.length; offset += 4) {
      outcomes.push(
        ...(await Promise.all(
          people
            .slice(offset, offset + 4)
            .map(async (email) => outcome(await ssoSignIn('campus', email, nat))),
        )),
      );
    }
    expect(outcomes).toEqual(people.map(() => 'ok'));
    expect(Date.now() - started).toBeLessThan(10_000);
    // Just-in-time provisioning applied the role mapping to every new account.
    const rows = await pool.db.execute<{ role: string; sessions: number }>(sql`
      select u.role, (select count(*) from session s where s.user_id = u.id)::integer as sessions
      from "user" u where u.email like 'student-%@campus.test'`);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.role === 'user' && row.sessions === 1)).toBe(true);
  });

  it('limits failed callbacks per address, not successful ones', async () => {
    const ip = address();
    await freshWindow();
    // The identity provider refuses these people (stub: `fail-` hints).
    for (let attempt = 0; attempt < ADDRESS_LIMIT; attempt++)
      expect(outcome(await ssoSignIn('campus', `fail-${attempt}@campus.test`, ip))).toMatch(
        /^failed 302/,
      );
    const refused = await ssoSignIn('campus', 'fail-x@campus.test', ip);
    expect(refused.status).toBe(429);
    const [entry] = await pool.db.execute<{ metadata: Record<string, unknown> }>(sql`
      select metadata from audit_log where action = 'auth.rate_limited' and ip_address = ${ip}`);
    expect(entry?.metadata).toMatchObject({ scope: 'ip', provider: 'campus' });
  });

  it('gives each identity provider its own budget', async () => {
    await freshWindow();
    // A misbehaving provider (or someone replaying its callbacks) uses up its own budget...
    for (let attempt = 0; attempt < PROVIDER_LIMIT; attempt++) {
      const response = await app.request(
        `/api/auth/sso/callback/flaky?state=${randomUUID()}&code=x`,
        { headers: { 'x-forwarded-for': address() } },
      );
      expect(response.status).not.toBe(429);
    }
    const refused = await app.request(`/api/auth/sso/callback/flaky?state=x&code=x`, {
      headers: { 'x-forwarded-for': address() },
    });
    expect(refused.status).toBe(429);
    // ...and nobody else's: the campus provider still signs people in.
    expect(
      outcome(await ssoSignIn('campus', `late-${randomUUID().slice(0, 6)}@campus.test`, address())),
    ).toBe('ok');
    const [entry] = await pool.db.execute<{ metadata: Record<string, unknown> }>(sql`
      select metadata from audit_log where action = 'auth.rate_limited'
        and metadata->>'scope' = 'provider'`);
    expect(entry?.metadata).toMatchObject({ provider: 'flaky', limit: PROVIDER_LIMIT });
  });
});
