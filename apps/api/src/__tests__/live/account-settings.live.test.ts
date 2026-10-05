import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
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

/**
 * Settings → Account (v0.9.1) against real PostgreSQL and the real Better
 * Auth instance: which sign-in methods /api/me reports (and whether a
 * password is usable under the local sign-in policy), changing a password
 * and a name through Better Auth with the server-side rules and audit, the
 * person's own devices, and the endpoints that must stay off (change email,
 * delete account).
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  localAuth: true,
  authUnreadable: false,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...actual,
    getSetting: async (key: string) => {
      if (key === 'auth') {
        if (state.authUnreadable) throw new Error('Injected settings failure');
        return {
          registrationMode: 'open',
          localAuthEnabled: state.localAuth,
          emailVerificationRequired: false,
          sessionLifetimeDays: 30,
          sessionRefreshDays: 1,
        };
      }
      return actual.getSetting(key as never);
    },
  };
});

const available = await livePostgresAvailable();
const password = 'Account-settings-test-123!';
const newPassword = 'Account-settings-next-456!';

describe.skipIf(!available)('live: Settings → Account', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];
  let app: Hono<AppBindings>;
  const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

  beforeAll(async () => {
    live = await createLiveDatabase('account_settings');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    ({ auth } = await import('../../auth/index.js'));
    const { meRoutes } = await import('../../routes/me.js');
    const { sessionMiddleware } = await import('../../middleware/context.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', sessionMiddleware);
    app.route('/api/me', meRoutes);
  });
  beforeEach(async () => {
    state.localAuth = true;
    state.authUnreadable = false;
    await pool.db.execute(sql`delete from audit_log`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  function authRequest(path: string, body: unknown, cookie?: string, method = 'POST') {
    return auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          origin,
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36',
          ...(cookie ? { cookie } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  function cookieFrom(response: Response): string {
    const token = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('oci.session_token='));
    if (!token) throw new Error(`No session cookie (status ${response.status})`);
    return token.split(';')[0]!;
  }

  /** A local account, signed in; `admin` makes it a verified administrator. */
  async function signedIn(role: 'user' | 'admin' = 'user') {
    const email = `${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, password, name: 'Account Fixture', role },
    });
    await pool.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, user.id));
    const response = await authRequest('/sign-in/email', { email, password });
    expect(response.status).toBe(200);
    return { user, email, cookie: cookieFrom(response) };
  }

  function me(path: string, cookie: string, init: RequestInit = {}) {
    return app.request(`/api/me${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  async function signInOf(cookie: string) {
    const response = await me('', cookie);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      signIn: { password: boolean; credential: boolean; sso: string[] };
      settingsSummary: { memoryEntries: number; connectors: number; shareLinks: number };
    };
  }

  async function audit(action: string) {
    return pool.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  }

  describe('sign-in methods on /api/me', () => {
    it('reports a usable password while local sign-in is on', async () => {
      const { cookie } = await signedIn();
      const body = await signInOf(cookie);
      expect(body.signIn).toEqual({ password: true, credential: true, sso: [] });
      expect(body.settingsSummary).toEqual({ memoryEntries: 0, connectors: 0, shareLinks: 0 });
    });

    it('reports an unusable password for a person once local sign-in is off', async () => {
      const { cookie } = await signedIn();
      state.localAuth = false;
      expect((await signInOf(cookie)).signIn).toEqual({
        password: false,
        credential: true,
        sso: [],
      });
      // An unreadable policy is not permission either.
      state.localAuth = true;
      state.authUnreadable = true;
      expect((await signInOf(cookie)).signIn.password).toBe(false);
    });

    it('keeps a verified administrator break-glass password usable', async () => {
      const { cookie } = await signedIn('admin');
      state.localAuth = false;
      expect((await signInOf(cookie)).signIn).toEqual({
        password: true,
        credential: true,
        sso: [],
      });
    });

    it('reports an SSO-only account by its provider label, without a password', async () => {
      const userId = await seedUser(pool.db, state.organizationId);
      await pool.db.insert(schema.ssoProvider).values({
        id: randomUUID(),
        issuer: 'https://idp.example.test',
        domain: 'example.test',
        providerId: 'campus-idp',
        label: 'Campus Login',
        organizationId: state.organizationId,
      });
      await pool.db.insert(schema.account).values({
        id: randomUUID(),
        userId,
        accountId: `sub-${userId}`,
        providerId: 'campus-idp',
      });
      const session = await pool.db
        .insert(schema.session)
        .values({
          id: randomUUID(),
          userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      const signedToken = await signedCookie(session[0]!.token);
      expect((await signInOf(signedToken)).signIn).toEqual({
        password: false,
        credential: false,
        sso: ['Campus Login'],
      });
    });

    it('counts memories for hiding an empty Memory tab', async () => {
      const { user, cookie } = await signedIn();
      await pool.db.insert(schema.userMemory).values({
        userId: user.id,
        content: 'Prefers short answers',
        source: 'person',
      });
      expect((await signInOf(cookie)).settingsSummary.memoryEntries).toBe(1);
    });
  });

  describe('deleting your own account (v0.10)', () => {
    it('ends the session and expires its cookies, and Better Auth’s endpoint stays off', async () => {
      const { updateSetting } = await import('../../services/settings.js');
      await updateSetting('roleFeatures', { roles: { user: { accountDeletion: true } } });
      try {
        const { user, email, cookie } = await signedIn();
        const [usage] = await pool.db
          .insert(schema.usageEvent)
          .values({
            organizationId: state.organizationId,
            userId: user.id,
            modelSlug: 'self-deleted-model',
            tokensIn: 3,
            tokensOut: 4,
            costMicros: 700,
          })
          .returning({ id: schema.usageEvent.id });
        // Better Auth's own endpoint is still disabled with the switch on.
        expect((await authRequest('/delete-user', { password }, cookie)).status).not.toBe(200);
        expect((await me('', cookie)).status).toBe(200);

        const response = await me('/delete-account', cookie, {
          method: 'POST',
          body: JSON.stringify({ confirmEmail: email, password }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const expired = response.headers
          .getSetCookie()
          .filter((value) => /max-age=0/i.test(value))
          .map((value) => value.split('=')[0]);
        expect(expired).toEqual(expect.arrayContaining(['oci.session_token', 'oci.session_data']));
        expect((await me('', cookie)).status).toBe(401);
        const rows = await pool.db
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, user.id));
        expect(rows).toHaveLength(0);
        // Their usage is kept for instance reports, without them (v0.10).
        const kept = await pool.db
          .select()
          .from(schema.usageEvent)
          .where(eq(schema.usageEvent.id, usage!.id));
        expect(kept).toEqual([
          expect.objectContaining({
            userId: null,
            modelSlug: 'self-deleted-model',
            costMicros: 700,
          }),
        ]);
        // Signing in again is refused: the account is gone.
        expect((await authRequest('/sign-in/email', { email, password })).status).toBe(401);
      } finally {
        await updateSetting('roleFeatures', { roles: {} });
      }
    });
  });

  /** Better Auth signs its cookie; produce one for a session made in SQL. */
  async function signedCookie(token: string): Promise<string> {
    const { makeSignature } = await import('better-auth/crypto');
    const signature = await makeSignature(token, process.env.AUTH_SECRET!);
    return `oci.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  }

  describe('Devices: when a session was last active (#98)', () => {
    it('moves while the session is used, not only at sign-in', async () => {
      const { user, cookie } = await signedIn();
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await pool.db
        .update(schema.session)
        .set({ createdAt: hourAgo, updatedAt: hourAgo })
        .where(eq(schema.session.userId, user.id));

      expect((await me('', cookie)).status).toBe(200);
      await vi.waitFor(async () => {
        const response = await me('/sessions', cookie);
        const { sessions } = (await response.json()) as {
          sessions: Array<{ createdAt: string; lastActiveAt: string }>;
        };
        expect(sessions[0]!.createdAt).toBe(hourAgo.toISOString());
        expect(Date.now() - Date.parse(sessions[0]!.lastActiveAt)).toBeLessThan(60_000);
      });
    });

    it('writes at most once per five minutes', async () => {
      const { user, cookie } = await signedIn();
      const minuteAgo = new Date(Date.now() - 60 * 1000);
      await pool.db
        .update(schema.session)
        .set({ updatedAt: minuteAgo })
        .where(eq(schema.session.userId, user.id));
      expect((await me('', cookie)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const [row] = await pool.db
        .select({ updatedAt: schema.session.updatedAt })
        .from(schema.session)
        .where(eq(schema.session.userId, user.id));
      expect(row!.updatedAt.toISOString()).toBe(minuteAgo.toISOString());
    });
  });

  describe('changing a password', () => {
    it('changes it, signs other devices out when asked, and audits the person', async () => {
      const { user, email, cookie } = await signedIn();
      const other = cookieFrom(await authRequest('/sign-in/email', { email, password }));
      const response = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword, revokeOtherSessions: true },
        cookie,
      );
      expect(response.status).toBe(200);
      // The other device is signed out; the new password signs in.
      expect((await me('', other)).status).toBe(401);
      expect((await authRequest('/sign-in/email', { email, password: newPassword })).status).toBe(
        200,
      );
      const [event] = await audit('auth.password.changed.success');
      expect(event).toMatchObject({ actorUserId: user.id });
      expect(JSON.stringify(event?.metadata)).not.toContain(newPassword);
    });

    it('records the actor even when other devices stay signed in', async () => {
      const { user, cookie } = await signedIn();
      const response = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword, revokeOtherSessions: false },
        cookie,
      );
      expect(response.status).toBe(200);
      expect(await audit('auth.password.changed.success')).toEqual([
        expect.objectContaining({ actorUserId: user.id }),
      ]);
    });

    it('refuses a wrong current password and a password under 12 characters', async () => {
      const { cookie } = await signedIn();
      const wrong = await authRequest(
        '/change-password',
        { currentPassword: 'Not-the-password-1!', newPassword },
        cookie,
      );
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      const short = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword: 'short-1' },
        cookie,
      );
      expect(short.status).toBe(400);
      expect(await audit('auth.password.changed.failure')).toHaveLength(2);
    });

    it('is refused for a person while local sign-in is off', async () => {
      const { email, cookie } = await signedIn();
      state.localAuth = false;
      const response = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword },
        cookie,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'LOCAL_AUTH_DISABLED' });
      state.localAuth = true;
      // The password did not change.
      expect((await authRequest('/sign-in/email', { email, password })).status).toBe(200);
    });

    it('is refused while the policy cannot be read', async () => {
      const { cookie } = await signedIn();
      state.authUnreadable = true;
      const response = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword },
        cookie,
      );
      expect(response.status).toBe(503);
    });

    it('stays available to a verified administrator while local sign-in is off', async () => {
      const { cookie } = await signedIn('admin');
      state.localAuth = false;
      const response = await authRequest(
        '/change-password',
        { currentPassword: password, newPassword },
        cookie,
      );
      expect(response.status).toBe(200);
    });
  });

  describe('changing a name', () => {
    it('trims and saves the name, and audits it', async () => {
      const { user, cookie } = await signedIn();
      const response = await authRequest('/update-user', { name: '  Ada Lovelace  ' }, cookie);
      expect(response.status).toBe(200);
      const [stored] = await pool.db.select().from(schema.user).where(eq(schema.user.id, user.id));
      expect(stored?.name).toBe('Ada Lovelace');
      expect(await audit('auth.profile.updated.success')).toEqual([
        expect.objectContaining({ actorUserId: user.id }),
      ]);
    });

    it.each([
      ['an empty name', { name: '   ' }, 'INVALID_NAME'],
      ['a name over 100 characters', { name: 'x'.repeat(101) }, 'INVALID_NAME'],
      ['an image', { name: 'Ada', image: 'https://example.test/a.png' }, 'PROFILE_NAME_ONLY'],
      ['no name at all', { image: 'https://example.test/a.png' }, 'PROFILE_NAME_ONLY'],
    ])('refuses %s', async (_label, body, code) => {
      const { cookie } = await signedIn();
      const response = await authRequest('/update-user', body, cookie);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code });
    });

    it('refuses a name change on an account that signs in through the organisation', async () => {
      const { user, cookie } = await signedIn();
      await pool.db.insert(schema.account).values({
        id: randomUUID(),
        userId: user.id,
        accountId: `sub-${user.id}`,
        providerId: 'campus-idp-linked',
      });
      const response = await authRequest('/update-user', { name: 'Someone Else' }, cookie);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'PROFILE_MANAGED_BY_SSO' });
    });
  });

  describe('endpoints that stay off', () => {
    it('refuses changing the email address and deleting the account', async () => {
      const { user, cookie } = await signedIn();
      const change = await authRequest(
        '/change-email',
        { newEmail: `${randomUUID()}@example.test` },
        cookie,
      );
      expect(change.status).toBeGreaterThanOrEqual(400);
      const remove = await authRequest('/delete-user', { password }, cookie);
      expect(remove.status).toBeGreaterThanOrEqual(400);
      const [stored] = await pool.db.select().from(schema.user).where(eq(schema.user.id, user.id));
      expect(stored?.email).toBe(user.email);
    });
  });

  describe('devices', () => {
    async function twoDevices() {
      const first = await signedIn();
      const second = cookieFrom(
        await authRequest('/sign-in/email', { email: first.email, password }),
      );
      await pool.db
        .update(schema.session)
        .set({ ipAddress: '203.0.113.42' })
        .where(eq(schema.session.userId, first.user.id));
      return { ...first, second };
    }

    async function sessionsOf(cookie: string) {
      const response = await me('/sessions', cookie);
      expect(response.status).toBe(200);
      return (
        (await response.json()) as {
          sessions: Array<{ id: string; current: boolean; ipAddress: string | null }>;
        }
      ).sessions;
    }

    it('lists this device first, with shortened addresses and no tokens', async () => {
      const { cookie } = await twoDevices();
      const response = await me('/sessions', cookie);
      const text = await response.clone().text();
      expect(text).not.toContain('token');
      const sessions = await sessionsOf(cookie);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ current: true, ipAddress: '203.0.113.x' });
      expect(sessions[1]).toMatchObject({ current: false });
    });

    it('signs one other device out, and audits it', async () => {
      const { user, cookie, second } = await twoDevices();
      const [, other] = await sessionsOf(cookie);
      const response = await me(`/sessions/${other!.id}`, cookie, { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect((await me('', second)).status).toBe(401);
      expect(await sessionsOf(cookie)).toHaveLength(1);
      expect(await audit('auth.session.revoked.success')).toEqual([
        expect.objectContaining({ actorUserId: user.id, targetId: other!.id }),
      ]);
    });

    it('will not sign out this device or anyone else’s session', async () => {
      const { cookie } = await twoDevices();
      const stranger = await twoDevices();
      const [current] = await sessionsOf(cookie);
      expect((await me(`/sessions/${current!.id}`, cookie, { method: 'DELETE' })).status).toBe(422);
      const [theirs] = await sessionsOf(stranger.cookie);
      expect((await me(`/sessions/${theirs!.id}`, cookie, { method: 'DELETE' })).status).toBe(404);
      expect(await sessionsOf(stranger.cookie)).toHaveLength(2);
    });

    it('signs out every other device and keeps this one', async () => {
      const { user, cookie, second } = await twoDevices();
      const response = await me('/sessions/revoke-others', cookie, { method: 'POST' });
      expect(await response.json()).toEqual({ revoked: 1 });
      expect((await me('', second)).status).toBe(401);
      expect((await me('', cookie)).status).toBe(200);
      const [event] = await audit('auth.sessions.revoked_others.success');
      expect(event).toMatchObject({ actorUserId: user.id, metadata: { count: 1 } });
    });

    it('audits Better Auth’s own revoke endpoints with the actor', async () => {
      const { user, cookie } = await twoDevices();
      const response = await authRequest('/revoke-other-sessions', {}, cookie);
      expect(response.status).toBe(200);
      expect(await audit('auth.sessions.revoked_others.success')).toEqual([
        expect.objectContaining({ actorUserId: user.id }),
      ]);
    });
  });
});
