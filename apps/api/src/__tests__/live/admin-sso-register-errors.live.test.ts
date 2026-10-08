import { APIError } from 'better-auth/api';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  /** What the SSO plugin's register endpoint does in the current test. */
  register: (async () => undefined) as (input: unknown) => Promise<unknown>,
  registerCalls: 0,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
// Better Auth trusts APP_URL plus AUTH_TRUSTED_ORIGINS; here, one IdP origin.
vi.mock('../../auth/index.js', () => ({
  auth: {
    $context: Promise.resolve({
      isTrustedOrigin: (url: string) => url.startsWith('https://idp.trusted.example'),
    }),
    api: {
      registerSSOProvider: (input: unknown) => {
        state.registerCalls += 1;
        return state.register(input);
      },
    },
  },
}));

const { ssoRoutes } = await import('../../routes/admin/sso.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const OIDC = {
  kind: 'oidc',
  providerId: 'walk-oidc',
  label: 'Walk OIDC',
  clientId: 'client',
  clientSecret: 'secret',
  allowedDomains: ['northbrook.edu'],
};

describe.skipIf(!available)('live: adding an SSO provider explains refusals', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  async function add(body: Record<string, unknown>) {
    const response = await app.request('/sso/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error: { message: string } },
    };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_sso_errors');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'SSO admin',
        email: 'sso-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.use('*', requireAdmin);
    app.route('/sso', ssoRoutes);
  });
  beforeEach(() => {
    state.register = async () => undefined;
    state.registerCalls = 0;
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('names the origin to add when an OIDC issuer is not trusted, instead of a 500', async () => {
    const { status, body } = await add({ ...OIDC, issuer: 'https://accounts.google.com' });
    expect(status).toBe(422);
    expect(body.error.message).toContain('https://accounts.google.com');
    expect(body.error.message).toContain('AUTH_TRUSTED_ORIGINS');
    expect(state.registerCalls).toBe(0);
  });

  it("passes the SSO plugin's own reason back when it refuses a configuration", async () => {
    state.register = async () => {
      throw new APIError('BAD_REQUEST', {
        code: 'discovery_invalid_json',
        message: 'The discovery document is not valid JSON.',
      });
    };
    const { status, body } = await add({
      ...OIDC,
      issuer: 'https://idp.trusted.example/realms/walk',
    });
    expect(status).toBe(422);
    expect(body.error.message).toBe('The discovery document is not valid JSON.');
    expect(state.registerCalls).toBe(1);
  });

  it('still reports a server fault in the plugin as a server error', async () => {
    state.register = async () => {
      throw new Error('database went away');
    };
    const { status } = await add({ ...OIDC, issuer: 'https://idp.trusted.example/realms/walk' });
    expect(status).toBe(500);
  });

  it('refuses a SAML provider (removed, #53) before registering anything', async () => {
    const { status, body } = await add({ ...OIDC, kind: 'saml', providerId: 'walk-saml' });
    expect(status).toBe(422);
    expect(body.error.message).toBe('SAML is no longer supported. Use OpenID Connect.');
    expect(state.registerCalls).toBe(0);
  });

  it('refuses an allowed domain that is not a domain', async () => {
    const { status } = await add({
      ...OIDC,
      issuer: 'https://idp.trusted.example/realms/walk',
      allowedDomains: ['northbrook.edu', '@bad'],
    });
    expect(status).toBe(422);
    expect(state.registerCalls).toBe(0);
  });
});
