import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from '../../../test/live-client.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { signCookieValue } from '../../../test/session-cookie.js';
import { secretFromUri, totp } from '../../../test/totp.js';
import {
  type AuthenticationOptionsJSON,
  type RegistrationOptionsJSON,
  SoftwareAuthenticator,
} from '../../../test/webauthn.js';

/**
 * Requiring two-step verification per role (v0.14, #399): the setting and its
 * safeguards, the gate on a real session for every kind of session there is,
 * who the requirement would limit, and getting back in (an administrator's
 * reset and the command line). Real PostgreSQL, Redis and Better Auth through
 * the whole application. The seeded administrator's shape is exercised on a
 * fresh account: nothing here enrols a shared fixture.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  sent: [] as Array<{ to: string; subject: string; text: string }>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string; text: string }) => {
        state.sent.push(mail);
        return { messageId: 'requirement' };
      },
    }),
  },
}));

const available = await livePostgresAvailable();
const password = 'Mfa-requirement-test-password-123!';
const DAY = 24 * 60 * 60 * 1000;
type Role = 'admin' | 'auditor' | 'user' | 'restricted';

describe.skipIf(!available)('live: requiring two-step verification', { timeout: 120_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];
  let app: ReturnType<typeof import('../../app.js')['createApp']>;
  let updateSetting: typeof import('../../services/settings.js')['updateSetting'];
  let settle: () => Promise<void>;
  const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;
  const rpId = new URL(origin).hostname;

  beforeAll(async () => {
    live = await createLiveDatabase('mfa_requirement');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    await pool.db.insert(schema.instanceSetting).values([
      {
        organizationId: state.organizationId,
        key: 'auth',
        value: {
          registrationMode: 'open',
          localAuthEnabled: true,
          emailVerificationRequired: false,
          sessionLifetimeDays: 30,
          sessionRefreshDays: 1,
        },
      },
      {
        organizationId: state.organizationId,
        key: 'smtp',
        value: {
          host: 'mail.example.test',
          port: 587,
          secure: false,
          fromAddress: 'oci@example.test',
          username: null,
          encryptedPassword: null,
        },
      },
    ]);
    ({ auth } = await import('../../auth/index.js'));
    ({ updateSetting } = await import('../../services/settings.js'));
    ({ settleAccountEmails: settle } = await import('../../services/account-email-delivery.js'));
    const { createApp } = await import('../../app.js');
    app = createApp();
  });
  beforeEach(async () => {
    state.sent.length = 0;
    await pool.db.execute(sql`delete from audit_log`);
    await pool.db.execute(sql`delete from two_factor`);
    await pool.db.execute(sql`delete from passkey`);
    await pool.db.execute(sql`update "user" set two_factor_enabled = false`);
    await updateSetting('auth', {
      mfaRequirement: { roles: [], graceDays: 14, since: {} },
    });
    await updateSetting('maintenance', { readOnly: false, reason: null });
    const redisKeys = await clearClaims();
    expect(redisKeys).toBeGreaterThanOrEqual(0);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  async function clearClaims() {
    const { resetLocalCodeClaims } = await import('../../services/limits/code-replay.js');
    resetLocalCodeClaims();
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(
      process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6389',
    );
    try {
      const keys = await redis.keys('oci:mfa-code:*');
      if (keys.length > 0) await redis.del(...keys);
      return keys.length;
    } finally {
      redis.disconnect();
    }
  }

  /** The requirement as the server stores it, as if saved `sinceDaysAgo` days ago. */
  async function require(roles: Role[], sinceDaysAgo: number, graceDays = 14) {
    const since = new Date(Date.now() - sinceDaysAgo * DAY).toISOString();
    await updateSetting('auth', {
      mfaRequirement: {
        roles,
        graceDays,
        since: Object.fromEntries(roles.map((role) => [role, since])),
      },
    });
  }

  async function person(role: Role = 'user', createdDaysAgo = 400) {
    const email = `${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: {
        email,
        password,
        name: 'Requirement Fixture',
        role: role === 'admin' ? 'admin' : 'user',
      },
    });
    await pool.db
      .update(schema.user)
      .set({
        emailVerified: true,
        role,
        createdAt: new Date(Date.now() - createdDaysAgo * DAY),
      })
      .where(eq(schema.user.id, user.id));
    return { id: user.id, email };
  }

  const browser = () => new LiveClient(app, origin);

  async function signedIn(role: Role = 'user', createdDaysAgo = 400) {
    const who = await person(role, createdDaysAgo);
    const client = browser();
    const response = await client.request('/api/auth/sign-in/email', {
      json: { email: who.email, password },
    });
    expect(response.status).toBe(200);
    return { ...who, client };
  }

  async function enrol(client: LiveClient) {
    const begun = await client.request<{ totpURI: string }>('/api/me/mfa/totp', {
      json: { password },
    });
    expect(begun.status).toBe(200);
    const secret = secretFromUri(begun.body.totpURI);
    const confirmed = await client.request<{ recoveryCodes: string[] }>(
      '/api/me/mfa/totp/confirm',
      {
        json: { code: totp(secret) },
      },
    );
    expect(confirmed.status).toBe(200);
    return { secret, recoveryCodes: confirmed.body.recoveryCodes };
  }

  /** Signs in with a password and an authenticator code (the next window's, since enrolling used this one). */
  async function signInWithCode(email: string, secret: string, stepOffset = 1) {
    const client = browser();
    const first = await client.request<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', {
      json: { email, password },
    });
    expect(first.body.twoFactorRedirect).toBe(true);
    const second = await client.request('/api/auth/two-factor/verify-totp', {
      json: { code: totp(secret, { stepOffset }) },
    });
    expect(second.status).toBe(200);
    return client;
  }

  /** A session made by a single sign-on callback, for an account the identity provider owns. */
  async function ssoSessionFor(userId: string, authMethod: string | null = 'sso') {
    const [session] = await pool.db
      .insert(schema.session)
      .values({
        id: randomUUID(),
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        authMethod,
      })
      .returning();
    const client = browser();
    client.jar.set(
      'oci.session_token',
      await signCookieValue((await auth.$context).secret, session!.token),
    );
    return client;
  }

  async function ssoOnlyPerson(role: Role = 'user') {
    const id = await seedUser(pool.db, state.organizationId, { role });
    await pool.db
      .update(schema.user)
      .set({ createdAt: new Date(Date.now() - 400 * DAY) })
      .where(eq(schema.user.id, id));
    await pool.db.insert(schema.account).values({
      id: randomUUID(),
      userId: id,
      accountId: `sub-${id}`,
      providerId: 'campus-idp',
    });
    return id;
  }

  const audit = (action: string) =>
    pool.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  type Summary = {
    mfa: {
      eligible: boolean;
      enrolled: boolean;
      required: boolean;
      deadline: string | null;
      limited: boolean;
    };
  };
  const summary = async (client: LiveClient) => (await client.request<Summary>('/api/me')).body.mfa;

  describe('the gate, on real sessions', () => {
    it('limits a password session of a required role past the grace, and leaves the way out open', async () => {
      const who = await signedIn('user');
      expect((await who.client.request('/api/threads')).status).toBe(200);
      await require(['user'], 100);

      const refused = await who.client.request<{
        error: { code: string; details: { reason: string; deadline: string; setupPath: string } };
      }>('/api/threads');
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
      expect(refused.body.error.details).toMatchObject({
        reason: 'enrol',
        setupPath: '/auth/mfa-setup',
      });
      // A read, a write and an administration route: the same.
      expect((await who.client.request('/api/threads', { json: {} })).status).toBe(403);
      expect((await who.client.request('/api/models')).status).toBe(403);
      expect((await who.client.request('/api/admin/settings')).status).toBe(403);

      // What stays open.
      expect((await who.client.request('/api/health/live')).status).toBe(200);
      expect((await who.client.request('/api/maintenance')).status).toBe(200);
      const me = await who.client.request<Summary>('/api/me');
      expect(me.status).toBe(200);
      expect(me.body.mfa).toMatchObject({
        eligible: true,
        enrolled: false,
        required: true,
        limited: true,
      });
      expect(me.body.mfa.deadline).toBeTruthy();
      expect((await who.client.request('/api/me/mfa')).status).toBe(200);
      expect(
        (await who.client.request('/api/me/sessions/revoke-others', { json: {} })).status,
      ).toBe(200);
    });

    it('lifts the limit once the person enrols, and the swapped session carries on', async () => {
      const who = await signedIn('user');
      await require(['user'], 100);
      expect((await who.client.request('/api/threads')).status).toBe(403);
      await enrol(who.client);
      expect((await who.client.request('/api/threads')).status).toBe(200);
      expect(await summary(who.client)).toMatchObject({
        enrolled: true,
        required: true,
        limited: false,
      });
    });

    it('lets a limited person sign out, and a new sign-in is challenged', async () => {
      const who = await signedIn('user');
      const { secret } = await enrol(who.client);
      await require(['user'], 100);
      expect((await who.client.request('/api/threads')).status).toBe(200);
      expect((await who.client.request('/api/auth/sign-out', { json: {} })).status).toBe(200);
      const again = await signInWithCode(who.email, secret);
      expect((await again.request('/api/threads')).status).toBe(200);
    });

    it('waits out the grace and says until when', async () => {
      const who = await signedIn('user');
      await require(['user'], 0, 14);
      expect((await who.client.request('/api/threads')).status).toBe(200);
      const mfa = await summary(who.client);
      expect(mfa).toMatchObject({ required: true, limited: false, enrolled: false });
      const days = (Date.parse(mfa.deadline ?? '') - Date.now()) / DAY;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('limits at once with a grace of 0, and without signing anyone out first', async () => {
      const who = await signedIn('user');
      expect((await who.client.request('/api/threads')).status).toBe(200);
      await require(['user'], 0, 0);
      expect((await who.client.request('/api/threads')).status).toBe(403);
      await require([], 0);
      expect((await who.client.request('/api/threads')).status).toBe(200);
    });

    it('gives a person made after the requirement their own grace', async () => {
      await require(['user'], 100, 14);
      const fresh = await signedIn('user', 2);
      expect((await fresh.client.request('/api/threads')).status).toBe(200);
      const old = await signedIn('user', 30);
      expect((await old.client.request('/api/threads')).status).toBe(403);
    });

    it('leaves other roles alone', async () => {
      await require(['restricted'], 100);
      const user = await signedIn('user');
      const restricted = await signedIn('restricted');
      expect((await user.client.request('/api/threads')).status).toBe(200);
      expect((await restricted.client.request('/api/threads')).status).toBe(403);
    });

    it('never limits a person who signs in only through the organisation, and holds a dual account to the password only', async () => {
      await require(['user'], 100);
      const ssoOnly = await ssoOnlyPerson();
      const ssoClient = await ssoSessionFor(ssoOnly, 'sso');
      expect((await ssoClient.request('/api/threads')).status).toBe(200);
      // Even a session recorded as a password one: there is no password to hold them to.
      const odd = await ssoSessionFor(ssoOnly, 'password');
      expect((await odd.request('/api/threads')).status).toBe(200);
      expect(await summary(odd)).toMatchObject({
        eligible: false,
        required: false,
        limited: false,
      });

      // A password and an organisation account: the password session is limited, the SSO one is not.
      const dual = await person('user');
      await pool.db.insert(schema.account).values({
        id: randomUUID(),
        userId: dual.id,
        accountId: `sub-${dual.id}`,
        providerId: 'campus-idp',
      });
      const passwordSession = browser();
      await passwordSession.request('/api/auth/sign-in/email', {
        json: { email: dual.email, password },
      });
      expect((await passwordSession.request('/api/threads')).status).toBe(403);
      const viaSso = await ssoSessionFor(dual.id, 'sso');
      expect((await viaSso.request('/api/threads')).status).toBe(200);
    });

    it('reads a session with no recorded method (an older one, or one a v0.13 replica made) as a password session', async () => {
      await require(['user'], 100);
      const who = await person('user');
      const client = await ssoSessionFor(who.id, null);
      expect((await client.request('/api/threads')).status).toBe(403);
    });

    it('asks an enrolled person with a password-only session to sign in again with the second step', async () => {
      const who = await signedIn('user');
      const { secret } = await enrol(who.client);
      // Another device, signed in before: a password session that predates the second step.
      const other = await ssoSessionFor(who.id, 'password');
      await require(['user'], 100);
      const refused = await other.request<{ error: { details: { reason: string } } }>(
        '/api/threads',
      );
      expect(refused.status).toBe(403);
      expect(refused.body.error.details.reason).toBe('second_step');
      const fresh = await signInWithCode(who.email, secret);
      expect((await fresh.request('/api/threads')).status).toBe(200);
    });

    it('counts a recovery-code session, and ends the credit when the second step is switched off', async () => {
      const who = await signedIn('user');
      const { recoveryCodes } = await enrol(who.client);
      await require(['user'], 100);
      const viaCode = browser();
      await viaCode.request('/api/auth/sign-in/email', { json: { email: who.email, password } });
      await viaCode.request('/api/auth/two-factor/verify-backup-code', {
        json: { code: recoveryCodes[0] },
      });
      expect((await viaCode.request('/api/threads')).status).toBe(200);
      // Switching it off (an administrator's reset, say) leaves a totp-method session unsatisfied.
      await pool.db
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.id, who.id));
      expect((await viaCode.request('/api/threads')).status).toBe(403);
    });

    it('counts a passkey session, and a passkey-only person with a password session is asked to set up', async () => {
      const who = await signedIn('user');
      const key = new SoftwareAuthenticator({ origin, rpId });
      const options = await who.client.request<RegistrationOptionsJSON>(
        '/api/auth/passkey/generate-register-options',
      );
      const added = await who.client.request('/api/auth/passkey/verify-registration', {
        json: { response: key.register(options.body), name: 'Key' },
      });
      expect(added.status).toBe(200);
      await require(['user'], 100);
      // The password session is limited: it has no second step.
      expect((await who.client.request('/api/threads')).status).toBe(403);
      expect(await summary(who.client)).toMatchObject({ enrolled: true, limited: true });
      // Signing in with the passkey satisfies the requirement.
      const viaPasskey = browser();
      const challenge = await viaPasskey.request<AuthenticationOptionsJSON>(
        '/api/auth/passkey/generate-authenticate-options',
      );
      const signedInResponse = await viaPasskey.request('/api/auth/passkey/verify-authentication', {
        json: { response: key.authenticate(challenge.body) },
      });
      expect(signedInResponse.status).toBe(200);
      expect((await viaPasskey.request('/api/threads')).status).toBe(200);
    });

    it('admits the second step while the service is read-only, and nothing else that writes', async () => {
      const who = await signedIn('user');
      const { secret } = await enrol(who.client);
      await updateSetting('maintenance', { readOnly: true, reason: 'Upgrade' });
      const client = browser();
      const first = await client.request<{ twoFactorRedirect?: boolean }>(
        '/api/auth/sign-in/email',
        {
          json: { email: who.email, password },
        },
      );
      expect(first.body.twoFactorRedirect).toBe(true);
      const second = await client.request('/api/auth/two-factor/verify-totp', {
        json: { code: totp(secret, { stepOffset: 1 }) },
      });
      expect(second.status).toBe(200);
      expect((await client.request('/api/me')).status).toBe(200);
      expect((await client.request('/api/threads', { json: {} })).status).toBe(423);
    });

    it('works with v0.13-shaped rows: no new columns written, a null method, a default flag', async () => {
      const id = randomUUID();
      // What a v0.13 replica writes: it names its own columns only.
      await pool.db.execute(sql`insert into "user" (id, name, email, email_verified, role, organization_id)
        values (${id}, 'Old', ${`${id}@example.test`}, true, 'user', ${state.organizationId})`);
      await pool.db.execute(sql`insert into session (id, user_id, token, expires_at)
        values (${randomUUID()}, ${id}, 'old-token', now() + interval '1 day')`);
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, id));
      expect(user?.twoFactorEnabled).toBe(false);
      const [session] = await pool.db
        .select()
        .from(schema.session)
        .where(eq(schema.session.userId, id));
      expect(session?.authMethod).toBeNull();
      // And the v0.13 queries still read it.
      const rows = await pool.db.execute(sql`select id, email, role from "user" where id = ${id}`);
      expect(rows).toHaveLength(1);
    });
  });

  describe('the seeded administrator is never locked out', () => {
    it('signs in, enrols and reaches /api/admin when admin is required and nobody is enrolled', async () => {
      const admin = await signedIn('admin');
      await require(['admin'], 100);
      // The setting was written straight to storage (the API refuses it): this is the worst case.
      expect((await admin.client.request('/api/admin/settings')).status).toBe(403);
      expect((await admin.client.request('/api/admin/users')).status).toBe(403);
      const me = await admin.client.request<Summary>('/api/me');
      expect(me.status).toBe(200);
      expect(me.body.mfa).toMatchObject({ required: true, limited: true });
      // The way out is open: sign-out, and enrolment.
      const { secret } = await enrol(admin.client);
      expect((await admin.client.request('/api/admin/settings')).status).toBe(200);
      // And the next sign-in works with the code.
      const again = await signInWithCode(admin.email, secret);
      expect((await again.request('/api/admin/settings')).status).toBe(200);
    });

    it('reaches the administration API with a passkey session as well', async () => {
      const admin = await signedIn('admin');
      const key = new SoftwareAuthenticator({ origin, rpId });
      const options = await admin.client.request<RegistrationOptionsJSON>(
        '/api/auth/passkey/generate-register-options',
      );
      await admin.client.request('/api/auth/passkey/verify-registration', {
        json: { response: key.register(options.body), name: 'Key' },
      });
      await require(['admin'], 100);
      expect((await admin.client.request('/api/admin/settings')).status).toBe(403);
      const viaPasskey = browser();
      const challenge = await viaPasskey.request<AuthenticationOptionsJSON>(
        '/api/auth/passkey/generate-authenticate-options',
      );
      await viaPasskey.request('/api/auth/passkey/verify-authentication', {
        json: { response: key.authenticate(challenge.body) },
      });
      expect((await viaPasskey.request('/api/admin/settings')).status).toBe(200);
    });
  });

  describe('saving the requirement', () => {
    const save = (
      client: LiveClient,
      mfaRequirement: unknown,
      extra: Record<string, unknown> = {},
    ) =>
      client.request<{
        ok?: boolean;
        error?: { code: string; message: string; details?: unknown };
      }>('/api/admin/settings', { method: 'PATCH', json: { mfaRequirement, ...extra } });
    const stored = async () =>
      await (await import('../../services/mfa/requirement.js')).currentRequirement();

    it('refuses an administrator who has not used a second step in this session, and saves nothing', async () => {
      const admin = await signedIn('admin');
      const response = await save(
        admin.client,
        { roles: ['user'], graceDays: 14 },
        { appName: 'Should not save' },
      );
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe('MFA_REQUIRED_FOR_ACTOR');
      expect(response.body.error?.details).toMatchObject({ reason: 'actor_not_satisfied' });
      expect((await stored()).roles).toEqual([]);
      const settings = await admin.client.request<{ appName: string }>('/api/admin/settings');
      expect(settings.body.appName).not.toBe('Should not save');
    });

    it('saves for an administrator who passed a second step, stamps the role, and audits the roles', async () => {
      const admin = await signedIn('admin');
      await enrol(admin.client);
      const response = await save(admin.client, { roles: ['restricted', 'user'], graceDays: 7 });
      expect(response.status).toBe(200);
      const requirement = await stored();
      expect(requirement.roles).toEqual(['user', 'restricted']);
      expect(requirement.graceDays).toBe(7);
      expect(Date.now() - Date.parse(requirement.since.user ?? '')).toBeLessThan(10_000);
      expect(Date.now() - Date.parse(requirement.since.restricted ?? '')).toBeLessThan(10_000);

      const read = await admin.client.request<{
        mfaRequirement: { roles: string[]; graceDays: number; since: Record<string, string> };
      }>('/api/admin/settings');
      expect(read.body.mfaRequirement).toMatchObject({
        roles: ['user', 'restricted'],
        graceDays: 7,
      });

      const [event] = await audit('settings.auth.update');
      expect(event?.metadata).toMatchObject({ keys: ['mfaRequirement'] });
      const changes =
        (event?.metadata as { changes?: Array<{ key: string; before: unknown; after: unknown }> })
          ?.changes ?? [];
      expect(changes.map((change) => change.key).sort()).toEqual([
        'mfaRequirement.graceDays',
        'mfaRequirement.roles',
      ]);
      expect(changes.find((change) => change.key === 'mfaRequirement.roles')).toMatchObject({
        before: [],
        after: ['restricted', 'user'],
      });
      expect(JSON.stringify(changes)).not.toContain('since');
    });

    it('keeps the stamp of a role that stays, stamps one added, and forgets one removed', async () => {
      const admin = await signedIn('admin');
      await enrol(admin.client);
      await require(['user'], 50, 14);
      const before = (await stored()).since.user;
      await save(admin.client, { roles: ['user', 'auditor'], graceDays: 30 });
      const after = await stored();
      expect(after.since.user).toBe(before);
      expect(Date.now() - Date.parse(after.since.auditor ?? '')).toBeLessThan(10_000);
      await save(admin.client, { roles: ['auditor'], graceDays: 30 });
      expect((await stored()).since.user).toBeUndefined();
    });

    it('refuses to name admin until a local administrator is enrolled, and counts only one who could complete it', async () => {
      // An administrator signed in through the organisation is satisfied, but is not a local one.
      const sso = await ssoOnlyPerson('admin');
      const ssoAdmin = await ssoSessionFor(sso, 'sso');
      const refused = await save(ssoAdmin, { roles: ['admin'], graceDays: 14 });
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe('MFA_REQUIRED_FOR_ACTOR');
      expect(refused.body.error?.details).toMatchObject({ reason: 'no_enrolled_admin' });

      // An enrolled local administrator who is banned does not count, nor does an unverified one.
      const local = await signedIn('admin');
      await enrol(local.client);
      await pool.db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, local.id));
      expect((await save(ssoAdmin, { roles: ['admin'], graceDays: 14 })).status).toBe(409);
      await pool.db
        .update(schema.user)
        .set({ banned: false, emailVerified: false })
        .where(eq(schema.user.id, local.id));
      expect((await save(ssoAdmin, { roles: ['admin'], graceDays: 14 })).status).toBe(409);
      await pool.db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, local.id));
      const saved = await save(ssoAdmin, { roles: ['admin'], graceDays: 14 });
      expect(saved.status).toBe(200);
      expect((await stored()).roles).toEqual(['admin']);
    });

    it('always lets an administrator remove the requirement, and an unchanged one rides along with other changes', async () => {
      const admin = await signedIn('admin');
      await require(['user'], 10, 14);
      const current = await stored();
      // Unchanged, with another setting: not a save of the requirement.
      const alongside = await save(
        admin.client,
        { roles: ['user'], graceDays: 14 },
        { appName: 'Renamed' },
      );
      expect(alongside.status).toBe(200);
      expect((await stored()).since.user).toBe(current.since.user);
      // Removing it is always allowed, even for a password-only session.
      const removed = await save(admin.client, { roles: [], graceDays: 14 });
      expect(removed.status).toBe(200);
      expect((await stored()).roles).toEqual([]);
    });

    it('validates the input: an unknown role, a negative or huge grace, and a stamp from the client', async () => {
      const admin = await signedIn('admin');
      expect((await save(admin.client, { roles: ['owner'], graceDays: 14 })).status).toBe(422);
      expect((await save(admin.client, { roles: ['user'], graceDays: -1 })).status).toBe(422);
      expect((await save(admin.client, { roles: ['user'], graceDays: 4000 })).status).toBe(422);
      expect(
        (
          await save(admin.client, {
            roles: ['user'],
            graceDays: 14,
            since: { user: '2020-01-01' },
          })
        ).status,
      ).toBe(422);
    });

    it('answers an instance that never saved one with nobody, and a v0.13 replica saving the page keeps the key', async () => {
      const admin = await signedIn('admin');
      await pool.db.execute(
        sql`update instance_setting set value = value - 'mfaRequirement' where key = 'auth'`,
      );
      const { invalidateSettingsCache } = await import('../../services/settings.js');
      invalidateSettingsCache();
      const read = await admin.client.request<{ mfaRequirement: unknown }>('/api/admin/settings');
      expect(read.body.mfaRequirement).toEqual({ roles: [], graceDays: 14, since: {} });
      // A v0.13 replica writes the auth object it knows (merged by updateSetting): the key survives.
      await require(['user'], 5);
      await updateSetting('auth', { sessionLifetimeDays: 20 });
      expect((await stored()).roles).toEqual(['user']);
    });

    it('is administrators only: an auditor cannot save it, a user cannot read the impact', async () => {
      const auditor = await signedIn('auditor');
      expect((await save(auditor.client, { roles: ['user'], graceDays: 14 })).status).toBe(403);
      expect((await auditor.client.request('/api/admin/settings/mfa-impact')).status).toBe(200);
      const user = await signedIn('user');
      expect((await user.client.request('/api/admin/settings/mfa-impact')).status).toBe(403);
    });
  });

  describe('who it would limit', () => {
    it('counts people per role: no password, set up, not set up, the first deadline and who is limited now', async () => {
      const admin = await signedIn('admin');
      await pool.db.execute(sql`delete from "user" where role = 'restricted'`);
      await signedIn('restricted', 100); // not set up
      const setUp = await signedIn('restricted', 100);
      await enrol(setUp.client);
      await ssoOnlyPerson('restricted');
      const banned = await person('restricted');
      await pool.db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, banned.id));
      await require(['restricted'], 100, 14);

      const response = await admin.client.request<{
        graceDays: number;
        roles: Array<{
          role: string;
          people: number;
          exempt: number;
          enrolled: number;
          unenrolled: number;
          required: boolean;
          since: string | null;
          firstDeadline: string | null;
          limitedNow: number;
        }>;
      }>('/api/admin/settings/mfa-impact');
      expect(response.status).toBe(200);
      expect(response.body.graceDays).toBe(14);
      expect(response.body.roles.map((row) => row.role)).toEqual([
        'admin',
        'auditor',
        'user',
        'restricted',
      ]);
      const restricted = response.body.roles.find((row) => row.role === 'restricted');
      expect(restricted).toMatchObject({
        people: 3,
        exempt: 1,
        enrolled: 1,
        unenrolled: 1,
        required: true,
        limitedNow: 1,
      });
      expect(restricted?.since).toBeTruthy();
      expect(restricted?.firstDeadline).toBeTruthy();
      const user = response.body.roles.find((row) => row.role === 'user');
      expect(user).toMatchObject({
        required: false,
        since: null,
        firstDeadline: null,
        limitedNow: 0,
      });
    });

    it('says nobody is limited yet before the grace has passed', async () => {
      const admin = await signedIn('admin');
      await signedIn('restricted', 100);
      await require(['restricted'], 1, 14);
      const response = await admin.client.request<{
        roles: Array<{ role: string; limitedNow: number; firstDeadline: string | null }>;
      }>('/api/admin/settings/mfa-impact');
      const restricted = response.body.roles.find((row) => row.role === 'restricted');
      expect(restricted?.limitedNow).toBe(0);
      expect(Date.parse(restricted?.firstDeadline ?? '')).toBeGreaterThan(Date.now());
    });
  });

  describe('getting back in', () => {
    async function enrolledWithPasskey() {
      const who = await signedIn('user');
      const { secret } = await enrol(who.client);
      const key = new SoftwareAuthenticator({ origin, rpId });
      const options = await who.client.request<RegistrationOptionsJSON>(
        '/api/auth/passkey/generate-register-options',
      );
      await who.client.request('/api/auth/passkey/verify-registration', {
        json: { response: key.register(options.body), name: 'Key' },
      });
      return { ...who, secret };
    }

    it('lets an administrator reset anyone: their factors and sessions go, they are emailed, it is audited', async () => {
      const admin = await signedIn('admin');
      const target = await enrolledWithPasskey();
      const detail = await admin.client.request<{ mfa: Record<string, unknown> }>(
        `/api/admin/users/${target.id}`,
      );
      expect(detail.body.mfa).toMatchObject({
        eligible: true,
        totp: true,
        passkeys: 1,
        recoveryCodesLeft: 10,
        lockedUntil: null,
        required: false,
      });
      expect(JSON.stringify(detail.body.mfa)).not.toContain(target.secret);

      const reset = await admin.client.request<{ ok: boolean; sessionsEnded: number }>(
        `/api/admin/users/${target.id}/mfa/reset`,
        { json: {} },
      );
      expect(reset.status).toBe(200);
      expect(reset.body.ok).toBe(true);
      expect(reset.body.sessionsEnded).toBeGreaterThanOrEqual(1);
      expect((await target.client.request('/api/me')).status).toBe(401);
      expect(
        await pool.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id)),
      ).toHaveLength(0);
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, target.id)),
      ).toHaveLength(0);
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, target.id));
      expect(user?.twoFactorEnabled).toBe(false);

      const [event] = await audit('user.mfa.reset');
      expect(event).toMatchObject({ actorUserId: admin.id, targetId: target.id });
      expect(event?.metadata).toMatchObject({ authenticator: true, passkeysRemoved: 1 });
      expect(JSON.stringify(event)).not.toContain(target.secret);
      await settle();
      expect(
        state.sent
          .filter((mail) => mail.to === target.email)
          .map((mail) => mail.subject)
          .join('\n'),
      ).toContain('reset by an administrator');

      // They sign in with the password alone, and may set it up again.
      const again = browser();
      const signedInAgain = await again.request<{ twoFactorRedirect?: boolean }>(
        '/api/auth/sign-in/email',
        {
          json: { email: target.email, password },
        },
      );
      expect(signedInAgain.status).toBe(200);
      expect(signedInAgain.body.twoFactorRedirect).toBeUndefined();
      expect((await again.request('/api/me')).status).toBe(200);
      await enrol(again);
    });

    it('does not reset oneself, an unknown person, or for a non-administrator; an auditor reads the status and cannot reset', async () => {
      const admin = await signedIn('admin');
      const target = await person('user');
      expect(
        (await admin.client.request(`/api/admin/users/${admin.id}/mfa/reset`, { json: {} })).status,
      ).toBe(422);
      expect(
        (await admin.client.request(`/api/admin/users/${randomUUID()}/mfa/reset`, { json: {} }))
          .status,
      ).toBe(404);
      const auditor = await signedIn('auditor');
      expect(
        (await auditor.client.request(`/api/admin/users/${target.id}/mfa/reset`, { json: {} }))
          .status,
      ).toBe(403);
      expect((await auditor.client.request(`/api/admin/users/${target.id}`)).status).toBe(200);
      const user = await signedIn('user');
      expect(
        (await user.client.request(`/api/admin/users/${target.id}/mfa/reset`, { json: {} })).status,
      ).toBe(403);
    });

    it('resets from the command line: sessions gone, an audit row, no secret printed, nothing decrypted', async () => {
      const target = await enrolledWithPasskey();
      const { cliResetMfa, NoSuchPersonError } = await import('../../services/mfa/reset.js');
      const outcome = await cliResetMfa(target.email.toUpperCase());
      expect(outcome).toMatchObject({
        email: target.email,
        authenticator: true,
        passkeysRemoved: 1,
      });
      expect(outcome.sessionsEnded).toBeGreaterThanOrEqual(1);
      expect((await target.client.request('/api/me')).status).toBe(401);
      expect(
        await pool.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id)),
      ).toHaveLength(0);
      const [event] = await audit('user.mfa_reset_cli');
      expect(event).toMatchObject({ targetId: target.id, actorUserId: null });
      expect(event?.metadata).toMatchObject({ mode: 'reset' });
      expect(JSON.stringify(event)).not.toContain(target.secret);
      await expect(cliResetMfa('nobody@example.test')).rejects.toBeInstanceOf(NoSuchPersonError);
    });

    it('--unlock only clears the lock: the factors and the sessions stay', async () => {
      const target = await enrolledWithPasskey();
      await pool.db
        .update(schema.twoFactor)
        .set({ failedVerificationCount: 10, lockedUntil: new Date(Date.now() + 10 * 60_000) })
        .where(eq(schema.twoFactor.userId, target.id));
      const { cliUnlockMfa } = await import('../../services/mfa/reset.js');
      await cliUnlockMfa(target.email);
      const [row] = await pool.db
        .select()
        .from(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, target.id));
      expect(row).toMatchObject({ failedVerificationCount: 0, lockedUntil: null, verified: true });
      expect((await target.client.request('/api/me')).status).toBe(200);
      expect((await audit('user.mfa_reset_cli'))[0]?.metadata).toMatchObject({ mode: 'unlock' });
    });

    it('--all removes every authenticator (for a changed AUTH_SECRET) and keeps the passkeys', async () => {
      const one = await enrolledWithPasskey();
      const two = await enrolledWithPasskey();
      const { cliResetAllAuthenticators } = await import('../../services/mfa/reset.js');
      const outcome = await cliResetAllAuthenticators();
      expect(outcome.authenticators).toBeGreaterThanOrEqual(2);
      expect(await pool.db.select().from(schema.twoFactor)).toHaveLength(0);
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, one.id)),
      ).toHaveLength(1);
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, two.id)),
      ).toHaveLength(1);
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, one.id));
      expect(user?.twoFactorEnabled).toBe(false);
    });

    it('works with a different AUTH_SECRET: the reset decrypts nothing', async () => {
      const target = await enrolledWithPasskey();
      // Unreadable now, as after a changed secret: a value no secret opens.
      await pool.db
        .update(schema.twoFactor)
        .set({ secret: 'not-decryptable', backupCodes: 'not-decryptable' })
        .where(eq(schema.twoFactor.userId, target.id));
      const { cliResetMfa } = await import('../../services/mfa/reset.js');
      await expect(cliResetMfa(target.email)).resolves.toMatchObject({ authenticator: true });
      expect(
        await pool.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id)),
      ).toHaveLength(0);
    });
  });
});
