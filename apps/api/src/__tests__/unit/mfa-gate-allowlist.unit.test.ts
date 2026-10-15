import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { concretePath, registeredRoutes } from '../../../test/registered-writes.js';
import type { AppBindings, SessionMfaFacts } from '../../middleware/context.js';

/**
 * The two-step verification requirement, enforced on the server (v0.14, #399):
 * every route the API registers, reads included, is refused with 403
 * MFA_ENROLMENT_REQUIRED for a limited session unless it is on the allowlist, so
 * a route added later cannot slip through; the allowed set is spelled out below
 * and widening it is a visible change. The decision table (role, method,
 * password account, grace, deadline, single sign-on, an older session) is here
 * too. The lookups are stubbed (the live test runs them against real
 * PostgreSQL); what is under test is which requests the gate lets through.
 */
const DAY = 24 * 60 * 60 * 1000;
const state = vi.hoisted(() => ({
  requirement: undefined as unknown,
  credential: true,
  credentialAsked: 0,
  settingFails: null as null | Error,
  role: 'user' as 'admin' | 'auditor' | 'user' | 'restricted',
  signedIn: true,
  facts: undefined as unknown,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'maintenance') return {};
    if (key === 'auth') {
      if (state.settingFails) throw state.settingFails;
      return { mfaRequirement: state.requirement };
    }
    throw new Error(`Nothing but the read-only check and the MFA gate may run here (read ${key})`);
  },
}));
vi.mock('../../services/policy-gate.js', () => ({ pendingPolicyFor: async () => null }));
vi.mock('../../services/mfa/credential.js', () => ({
  hasCredentialAccount: async () => {
    state.credentialAsked++;
    return state.credential;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { createApiRoutes } = await import('../../routes/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { auth } = await import('../../auth/index.js');
const { MFA_ALLOWLIST, mfaAllowance } = await import('../../middleware/mfa-gate.js');

const app = new Hono<AppBindings>();
app.onError(errorHandler);
app.use('*', async (c, next) => {
  c.set(
    'user',
    state.signedIn
      ? {
          id: 'person-1',
          email: 'person@example.test',
          name: 'Person',
          image: null,
          role: state.role,
          emailVerified: true,
          organizationId: 'org-1',
        }
      : null,
  );
  c.set('mfa', state.facts as SessionMfaFacts | null | undefined);
  await next();
});
app.route('/api', createApiRoutes());

const routes = registeredRoutes(app, auth);
const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
const iso = (date: Date) => date.toISOString();

function require(
  roles: Array<'admin' | 'auditor' | 'user' | 'restricted'>,
  sinceDaysAgo: number,
  graceDays = 14,
) {
  const since = iso(new Date(Date.now() - sinceDaysAgo * DAY));
  state.requirement = {
    roles,
    graceDays,
    since: Object.fromEntries(roles.map((role) => [role, since])),
  };
}

function session(method: string | null, twoFactorEnabled = false, accountAgeDays = 400) {
  state.facts = {
    authMethod: method,
    twoFactorEnabled,
    userCreatedAt: new Date(Date.now() - accountAgeDays * DAY),
  } satisfies SessionMfaFacts;
}

async function call(method: string, path: string) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });
}

beforeEach(() => {
  state.requirement = undefined;
  state.credential = true;
  state.credentialAsked = 0;
  state.settingFails = null;
  state.role = 'user';
  state.signedIn = true;
  session('password');
});

describe('every registered route, reads included, is refused for a limited session unless allowlisted', () => {
  it('finds the routes (sanity)', () => {
    expect(routes.length).toBeGreaterThan(300);
    for (const expected of [
      'GET /api/threads',
      'GET /api/me',
      'GET /api/admin/users',
      'POST /api/chat',
      'GET /api/me/mfa',
      'POST /api/me/mfa/totp/confirm',
      'GET /api/auth/get-session',
      'POST /api/auth/sign-out',
      'POST /api/auth/two-factor/verify-totp',
    ])
      expect(routes.map(key)).toContain(expected);
  });

  it('allows exactly these routes for a limited session', () => {
    const allowed = routes
      .filter((route) => mfaAllowance(route.method, concretePath(route.path)))
      .map(key)
      // Better Auth's many routes are one entry; they are checked as a group below.
      .filter((route) => !route.includes('/api/auth/'))
      .sort();
    expect(allowed).toMatchInlineSnapshot(`
      [
        "DELETE /api/me/sessions/:id",
        "GET /api/branding/logo",
        "GET /api/health/live",
        "GET /api/health/ready",
        "GET /api/maintenance",
        "GET /api/me",
        "GET /api/me/mfa",
        "POST /api/me/mfa/recovery-codes",
        "POST /api/me/mfa/totp",
        "POST /api/me/mfa/totp/confirm",
        "POST /api/me/mfa/totp/disable",
        "POST /api/me/sessions/revoke-others",
      ]
    `);
    // Better Auth's endpoints under /api/auth, as a group.
    for (const route of routes.filter((entry) => entry.path.startsWith('/api/auth/')))
      expect(mfaAllowance(route.method, concretePath(route.path)), key(route)).not.toBeNull();
  });

  it('has no allowlist entry that matches no route', () => {
    for (const entry of MFA_ALLOWLIST) {
      expect(
        routes.some(
          (route) =>
            (entry.methods === '*' || entry.methods.includes(route.method)) &&
            mfaAllowance(route.method, concretePath(route.path)) === entry,
        ),
        `${entry.methods} ${entry.path}`,
      ).toBe(true);
    }
  });

  it('refuses every other route with 403 MFA_ENROLMENT_REQUIRED, before any work', async () => {
    require(['user'], 100);
    session('password');
    const refused = routes.filter(
      (route) => route.method !== 'ALL' && !mfaAllowance(route.method, concretePath(route.path)),
    );
    expect(refused.length).toBeGreaterThan(150);
    // A read and an administration route are in it, which is the point.
    expect(refused.map(key)).toContain('GET /api/threads');
    expect(refused.map(key)).toContain('GET /api/admin/users');
    for (const route of refused) {
      const response = await call(route.method, concretePath(route.path));
      expect(response.status, key(route)).toBe(403);
      const body = (await response.json()) as {
        error: { code: string; details: { reason: string; setupPath: string } };
      };
      expect(body.error.code, key(route)).toBe('MFA_ENROLMENT_REQUIRED');
      expect(body.error.details).toMatchObject({ reason: 'enrol', setupPath: '/auth/mfa-setup' });
    }
  });

  it('lets an allowlisted route through to its own handler', async () => {
    require(['user'], 100);
    // The handler's own work is not stubbed here (a route that needs a setting
    // the mock refuses answers 500): anything but the gate's 403 shows it let the request by.
    for (const [method, path] of [
      ['GET', '/api/health/live'],
      ['GET', '/api/maintenance'],
      ['POST', '/api/auth/sign-out'],
      ['GET', '/api/auth/status'],
      ['GET', '/api/me/mfa'],
      ['DELETE', '/api/me/sessions/some-id'],
    ] as const) {
      const response = await call(method, path);
      expect(response.status, `${method} ${path}`).not.toBe(403);
      expect(await response.text(), path).not.toContain('MFA_ENROLMENT_REQUIRED');
    }
  });
});

describe('the decision table', () => {
  const refused = async (path = '/api/threads') => (await call('GET', path)).status === 403;

  it('does nothing when nobody is required, and reads no more than the setting', async () => {
    state.requirement = undefined;
    expect(await refused()).toBe(false);
    require([], 100);
    expect(await refused()).toBe(false);
    expect(state.credentialAsked).toBe(0);
  });

  it('limits a required role on a password session past the grace', async () => {
    require(['user'], 100);
    expect(await refused()).toBe(true);
    expect(state.credentialAsked).toBe(1);
  });

  it('does not limit a role that is not required', async () => {
    require(['admin'], 100);
    state.role = 'user';
    expect(await refused()).toBe(false);
    state.role = 'admin';
    expect(await refused()).toBe(true);
  });

  it('applies to every role and has no exemption (the break-glass administrator included)', async () => {
    require(['admin', 'auditor', 'user', 'restricted'], 100);
    for (const role of ['admin', 'auditor', 'user', 'restricted'] as const) {
      state.role = role;
      expect(await refused(), role).toBe(true);
      expect(await refused('/api/admin/settings'), role).toBe(true);
    }
  });

  it('waits out the grace, counted from the later of the role stamp and the account', async () => {
    require(['user'], 3, 14);
    expect(await refused()).toBe(false);
    // An account made after the requirement starts its own grace.
    require(['user'], 100, 14);
    session('password', false, 5);
    expect(await refused()).toBe(false);
    session('password', false, 15);
    expect(await refused()).toBe(true);
  });

  it('limits at once with a grace of 0', async () => {
    require(['user'], 0, 0);
    session('password', false, 400);
    expect(await refused()).toBe(true);
  });

  it('lets a satisfied session through: totp or a recovery code with the second step on, a passkey, single sign-on', async () => {
    require(['user'], 100);
    for (const [method, enabled] of [
      ['totp', true],
      ['recovery_code', true],
      ['passkey', false],
      ['passkey', true],
      ['sso', false],
    ] as const) {
      session(method, enabled);
      expect(await refused(), `${method} ${enabled}`).toBe(false);
    }
    expect(state.credentialAsked).toBe(0);
  });

  it('limits a totp session once the second step was switched off, and asks an enrolled person to sign in again', async () => {
    require(['user'], 100);
    session('totp', false);
    expect(await refused()).toBe(true);
    session('password', true);
    const response = await call('GET', '/api/threads');
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('second_step');
  });

  it('reads a session with no recorded method (older, or from a v0.13 replica) as a password session', async () => {
    require(['user'], 100);
    session(null);
    expect(await refused()).toBe(true);
    session('other');
    expect(await refused()).toBe(true);
  });

  it('never limits a person with no password account (single sign-on only)', async () => {
    require(['user'], 100);
    state.credential = false;
    session('password');
    expect(await refused()).toBe(false);
  });

  it("answers anonymous requests with the route's own 401, not a refusal", async () => {
    require(['user'], 100);
    state.signedIn = false;
    expect((await call('GET', '/api/threads')).status).toBe(401);
  });

  it('refuses when the facts are missing, rather than guessing a later deadline', async () => {
    require(['user'], 100);
    state.facts = undefined;
    expect(await refused()).toBe(true);
  });

  it('is an error the client may retry, never a bypass, when the setting cannot be read', async () => {
    state.settingFails = new Error('settings unavailable');
    const response = await call('GET', '/api/threads');
    expect(response.status).toBe(500);
    // The allowlist never reads it: signing out and the way out still work.
    expect((await call('GET', '/api/health/live')).status).toBe(200);
  });
});
