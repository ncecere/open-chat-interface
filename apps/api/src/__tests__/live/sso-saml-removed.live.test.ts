import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * SAML sign-in was removed from OCI (#53); OpenID Connect stays. Through the
 * real app, real Better Auth and PostgreSQL:
 *
 * - a provider of kind "saml" cannot be created, and the 422 names the `kind`
 *   field and says what to use instead;
 * - `@better-auth/sso` still ships /sso/saml2/* routes, and none answers;
 * - a SAML provider row left by an earlier release stays in the table (a
 *   rollback restores it) but is inert: not offered at sign-in, listed for
 *   the administrator, impossible to enable or edit, and deletable.
 */
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
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE: 1000,
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

const available = await livePostgresAvailable();
const PASSWORD = 'saml-removed-password-1234';
const SAML_MESSAGE = 'SAML is no longer supported. Use OpenID Connect.';
const INERT_MESSAGE =
  'SAML 2.0 is no longer supported. This provider is not offered at sign-in; delete it or replace it with an OpenID Connect provider.';

describe.skipIf(!available)('live: SAML sign-in is removed', { timeout: 30_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let cookie = '';
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  function request(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function insertProvider(providerId: string, kind: 'saml' | 'oidc', enabled: boolean) {
    await pool.db.insert(schema.ssoProvider).values({
      id: randomUUID(),
      issuer: `https://${providerId}.example.test`,
      domain: 'example.test',
      providerId,
      organizationId: state.organizationId,
      label: `Label ${providerId}`,
      kind,
      enabled,
      domainVerified: true,
      // What the old registration stored for a SAML provider.
      samlConfig:
        kind === 'saml' ? JSON.stringify({ entryPoint: 'https://idp.example.test' }) : null,
      oidcConfig: kind === 'oidc' ? JSON.stringify({ clientId: 'client' }) : null,
    });
  }

  async function row(providerId: string) {
    const [found] = await pool.db
      .select()
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.providerId, providerId));
    return found;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('saml_removed');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { sessionMiddleware } = await import('../../middleware/context.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', sessionMiddleware);
    app.route('/api', createApiRoutes());

    // A signed-in administrator, as the Better Auth admin endpoint test does.
    const { auth } = await import('../../auth/index.js');
    const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Admin' },
    });
    await pool.db.execute(sql`update "user" set role = 'admin' where id = ${created.user.id}`);
    const response = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  });

  afterAll(async () => {
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('refuses to create a SAML provider, at the kind field, and stores nothing', async () => {
    const response = await request('POST', '/api/admin/sso/providers', {
      kind: 'saml',
      providerId: 'new-saml',
      label: 'New SAML',
      issuer: 'https://idp.example.test/saml',
      entryPoint: 'https://idp.example.test/saml/sso',
      idpCertificate: 'not needed: the kind is refused first',
      allowedDomains: ['example.edu'],
    });
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details: Array<{ path: string[]; message: string }>;
      };
    };
    expect(response.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe(SAML_MESSAGE);
    // The issue at `kind` carries the sentence (the body's other SAML-only
    // fields are also not part of an OIDC provider, so more issues follow).
    expect(body.error.details).toContainEqual(
      expect.objectContaining({ path: ['kind'], message: SAML_MESSAGE }),
    );
    expect(await row('new-saml')).toBeUndefined();
  });

  it('still reports an unknown kind generically, not as SAML', async () => {
    const response = await request('POST', '/api/admin/sso/providers', {
      kind: 'ldap',
      providerId: 'new-ldap',
      label: 'LDAP',
    });
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(422);
    expect(body.error.message).toBe('Request validation failed');
  });

  it('answers every SAML endpoint the SSO plugin ships with 404', async () => {
    await insertProvider('legacy-routes', 'saml', true);
    const attempts: Array<[string, string]> = [
      ['POST', '/api/auth/sso/saml2/sp/acs/legacy-routes'],
      ['POST', '/api/auth/sso/saml2/callback/legacy-routes'],
      ['POST', '/api/auth/sso/saml2/sp/slo/legacy-routes'],
      ['POST', '/api/auth/sso/saml2/logout/legacy-routes'],
      ['GET', '/api/auth/sso/saml2/sp/metadata?providerId=legacy-routes'],
      ['GET', '/api/auth/sso/saml2/sp/acs/legacy-routes'],
      ['GET', '/api/auth/sso/saml2/anything-else'],
    ];
    for (const [method, path] of attempts) {
      for (const withSession of [true, false]) {
        const response = await app.request(path, {
          method,
          headers: { origin, ...(withSession ? { cookie } : {}) },
        });
        expect(response.status, `${method} ${path} (session: ${withSession})`).toBe(404);
        expect(await response.json()).toMatchObject({ message: SAML_MESSAGE });
      }
    }
  });

  it('keeps a legacy provider inert: hidden at sign-in, listed, not editable, deletable', async () => {
    await insertProvider('legacy-saml', 'saml', true);
    await insertProvider('campus-oidc', 'oidc', true);
    await insertProvider('off-oidc', 'oidc', false);
    const before = await row('legacy-saml');

    // Not offered at sign-in; the enabled OpenID Connect provider still is.
    const status = await app.request('/api/auth/status');
    expect(status.status).toBe(200);
    const offered = ((await status.json()) as { ssoProviders: Array<{ providerId: string }> })
      .ssoProviders;
    expect(offered.map((provider) => provider.providerId)).toEqual(['campus-oidc']);

    // Still listed for the administrator, as SAML, with no address to register.
    const list = await request('GET', '/api/admin/sso/providers');
    expect(list.status).toBe(200);
    const providers = (
      (await list.json()) as {
        providers: Array<{ providerId: string; kind: string; callbackUrl: string | null }>;
      }
    ).providers;
    expect(providers.find((provider) => provider.providerId === 'legacy-saml')).toMatchObject({
      kind: 'saml',
      callbackUrl: null,
    });
    expect(providers.find((provider) => provider.providerId === 'campus-oidc')).toMatchObject({
      kind: 'oidc',
      callbackUrl: expect.stringContaining('/api/auth/sso/callback/campus-oidc'),
    });

    // Enabling or editing it is refused, and the row is untouched.
    for (const patch of [{ enabled: false }, { label: 'Renamed' }, { autoRedirect: true }]) {
      const refused = await request('PATCH', '/api/admin/sso/providers/legacy-saml', patch);
      expect(refused.status, JSON.stringify(patch)).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        INERT_MESSAGE,
      );
    }
    expect(await row('legacy-saml')).toEqual(before);

    // An OpenID Connect provider is edited as before.
    const edited = await request('PATCH', '/api/admin/sso/providers/off-oidc', { enabled: true });
    expect(edited.status).toBe(200);
    expect((await row('off-oidc'))?.enabled).toBe(true);

    // Deleting it works, and takes only that row.
    const deleted = await request('DELETE', '/api/admin/sso/providers/legacy-saml');
    expect(deleted.status).toBe(200);
    expect(await row('legacy-saml')).toBeUndefined();
    expect(await row('campus-oidc')).toBeDefined();
  });
});
