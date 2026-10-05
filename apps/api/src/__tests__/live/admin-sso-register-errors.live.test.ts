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

/** A throwaway self-signed certificate (CN=walk-test-idp), only ever used here. */
const TEST_IDP_CERTIFICATE_BODY =
  'MIICrDCCAZQCCQDT/6PoRLJ+7TANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQDDA13YWxrLXRlc3QtaWRwMB4XDTI2MTAwNTE3NDQyN1oXDTM2MTAwMjE3NDQyN1owGDEWMBQGA1UEAwwNd2Fsay10ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJTbNbGk/Wl4Ng0vz6w872wH0FwLqUdDO0AmzofMJCm7fqBK6VtCB6wDKVpXzlUt5ROuhWNkfdDPYvx5AJ6sJIl4cipLXgMxtB+pa9qitMDtjU/cijpgiuN2mD+ux78M7zRY7vhNS/vHRBOKMCA5QPsNClpmXWUu3F5SyhROzTH+g8FgdD37nAO2282SR71zLja79BFFWg4BLJNOmGTnNBtpmAmRSpMbVjGnPIJ3neyo/ymag9fzV9UJXFdpNgPB0q+ghQK+iUJr9AAKXzZlyYEJOUNM3s2AtYRy3U59R/JMwEt0jbUZ7RaBCbI+0IbGmmsjGgP+arDT+GBpuMQ0sekCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAgoo5077PLmTjMPaqhhdlNWPvSqUC1TPKeNo97szF4K+jN8bESmyTiRdhja0/HQ2z+9Lb5TBPoMl+TmSeZSeJoaBeuGAdgpNEJQ0MsOGbTgaVzhdH6U2BqA31xKcLP3L3TJnRKl30IgAGrhB1bqWhZYygxQ39+YZfzx1WDL4ndeCrV8JkbRgvLvuEiDH9rFAyfyt86dy29to0nMi1ZQERHaI75si1+/BzamWy/vMmtNbNLdtj1x0yI6qU4hFtmyiArQvyOASXZWiKCGHt/fOEinnjqlydhcVuV7EXkEc7IfDbpmxo6xQS8j2xCYN7RdYW21ebA2Db8+mKG2ZQCLPHKg==';

const SAML = {
  kind: 'saml',
  providerId: 'walk-saml',
  label: 'Walk SAML',
  issuer: 'https://idp.trusted.example/saml',
  entryPoint: 'https://idp.trusted.example/saml/sso',
  idpCertificate: TEST_IDP_CERTIFICATE_BODY,
  allowedDomains: ['northbrook.edu'],
};

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

  it('refuses a SAML certificate that is not one, before registering anything', async () => {
    const { status, body } = await add({ ...SAML, idpCertificate: 'this is not a certificate' });
    expect(status).toBe(422);
    expect(body.error.message).toContain('not a valid X.509 certificate');
    expect(state.registerCalls).toBe(0);
  });

  it('accepts a real certificate, as PEM or as its bare base64 body', async () => {
    await add({ ...SAML, providerId: 'walk-saml-body' });
    await add({
      ...SAML,
      providerId: 'walk-saml-pem',
      idpCertificate: `-----BEGIN CERTIFICATE-----\n${TEST_IDP_CERTIFICATE_BODY}\n-----END CERTIFICATE-----`,
    });
    expect(state.registerCalls).toBe(2);
  });

  it('refuses an allowed domain that is not a domain', async () => {
    const { status } = await add({ ...SAML, allowedDomains: ['northbrook.edu', '@bad'] });
    expect(status).toBe(422);
    expect(state.registerCalls).toBe(0);
  });
});
