import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settingsError: false,
  useStoredAuth: false,
  authReads: 0,
  failRepeatedAuthRead: false,
  smtpSettingsError: false,
  required: true,
  localAuth: true,
  registration: 'open',
  smtpConfigured: true,
  deliveryFails: false,
  mail: [] as Array<{ to: string; text: string }>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'auth') {
      state.authReads++;
      if (state.settingsError || (state.failRepeatedAuthRead && state.authReads > 1))
        throw new Error('Injected settings failure');
      if (state.useStoredAuth) {
        const settings = await vi.importActual<typeof import('../../services/settings.js')>(
          '../../services/settings.js',
        );
        return settings.getSetting('auth');
      }
      return {
        registrationMode: state.registration,
        localAuthEnabled: state.localAuth,
        emailVerificationRequired: state.required,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    }
    if (key === 'smtp' && state.smtpSettingsError)
      throw new Error('Injected SMTP settings failure');
    if (key === 'smtp')
      return {
        host: state.smtpConfigured ? 'smtp.invalid' : null,
        port: 25,
        fromAddress: 'no-reply@example.test',
        secure: false,
        username: null,
        encryptedPassword: null,
      };
    return {};
  },
}));
// Keep the real delivery service, but inject transport rejection without using
// an existing developer SMTP server or sending mail outside this test.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; text: string }) => {
        if (state.deliveryFails) throw new Error('Injected SMTP rejection');
        state.mail.push(mail);
      },
    }),
  },
}));

const available = await livePostgresAvailable();
const password = 'Test-only-Verification-123!';

describe.skipIf(!available)('live Postgres and Better Auth: email verification', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];
  beforeAll(async () => {
    live = await createLiveDatabase('email_verification');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    ({ auth } = await import('../../auth/index.js'));
  });
  beforeEach(() => {
    state.required = true;
    state.localAuth = true;
    state.registration = 'open';
    state.settingsError = false;
    state.useStoredAuth = false;
    state.authReads = 0;
    state.failRepeatedAuthRead = false;
    state.smtpSettingsError = false;
    state.smtpConfigured = true;
    state.deliveryFails = false;
    state.mail = [];
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  function request(path: string, body: Record<string, unknown>) {
    return auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify(body),
      }),
    );
  }
  async function credential(role = 'user', emailVerified = false) {
    const email = `${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, password, name: 'Fixture', role: role as 'admin' | 'user' },
    });
    if (emailVerified)
      await pool.db.update(schema.user).set({ emailVerified }).where(eq(schema.user.id, user.id));
    return user;
  }
  async function stored(id: string) {
    const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, id));
    return user!;
  }
  async function signup() {
    const email = `${randomUUID()}@example.test`;
    const response = await request('/sign-up/email', {
      email,
      password,
      name: 'Verification test',
    });
    const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.email, email));
    return { email, response, user };
  }
  async function expectNoSession(userId: string | undefined, response: Response) {
    expect((response.headers.get('set-cookie') ?? '').includes('oci.session_token=')).toBe(false);
    if (userId) {
      expect(
        await pool.db.select().from(schema.session).where(eq(schema.session.userId, userId)),
      ).toHaveLength(0);
    }
  }

  it('does not verify or issue a session after SMTP rejects delivery', async () => {
    state.deliveryFails = true;
    const { response, user } = await signup();
    expect(user?.emailVerified ?? false).toBe(false);
    await expectNoSession(user?.id, response);
    expect(user).toBeDefined();
    const signin = await request('/sign-in/email', { email: user!.email, password });
    expect(signin.status).toBe(403);
    await expectNoSession(user?.id, signin);
  });

  it('does not reveal an unverified account before checking the password', async () => {
    const user = await credential();
    const existing = await request('/sign-in/email', {
      email: user.email,
      password: 'Wrong-test-password-123!',
    });
    const unknown = await request('/sign-in/email', {
      email: `${randomUUID()}@example.test`,
      password,
    });
    expect(existing.status).toBe(401);
    expect(unknown.status).toBe(existing.status);
    expect(await existing.json()).toEqual(await unknown.json());
    await expectNoSession(user.id, existing);
    expect(state.mail).toHaveLength(0);
    const validPassword = await request('/sign-in/email', { email: user.email, password });
    expect(validPassword.status).toBe(403);
    expect(await validPassword.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await expectNoSession(user.id, validPassword);
  });

  it('requires verification before issuing a signup session, even when delivery succeeds', async () => {
    const { response, user } = await signup();
    expect(response.status).toBe(200);
    expect(user?.emailVerified).toBe(false);
    await expectNoSession(user?.id, response);
    expect(await response.json()).toMatchObject({ token: null });
  });

  it.each(['missing', 'unreadable'])(
    'does not waive verification when SMTP is %s',
    async (failure) => {
      state.smtpConfigured = false;
      state.smtpSettingsError = failure === 'unreadable';
      const { response, user } = await signup();
      expect(user?.emailVerified ?? false).toBe(false);
      await expectNoSession(user?.id, response);
    },
  );

  it('allows resend after recovery, and grants access only after consuming a valid link', async () => {
    state.deliveryFails = true;
    const { user } = await signup();
    expect(user).toBeDefined();
    const failedResend = await request('/send-verification-email', {
      email: user!.email,
      callbackURL: '/',
    });
    expect(failedResend.status).toBe(200);
    expect((await stored(user!.id)).emailVerified).toBe(false);
    expect(state.mail).toHaveLength(0);
    state.deliveryFails = false;
    const resend = await request('/send-verification-email', {
      email: user!.email,
      callbackURL: '/',
    });
    expect(resend.status).toBe(200);
    expect((await stored(user!.id)).emailVerified).toBe(false);
    await expectNoSession(user!.id, resend);
    const url = state.mail.at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
    expect(typeof url).toBe('string');
    const invalid = new URL(url!);
    invalid.searchParams.set('token', 'invalid-token');
    await auth.handler(new Request(invalid));
    expect((await stored(user!.id)).emailVerified).toBe(false);
    const verified = await auth.handler(new Request(url!));
    expect(verified.status).toBe(302);
    expect((await stored(user!.id)).emailVerified).toBe(true);
    const signin = await request('/sign-in/email', { email: user!.email, password });
    expect(signin.status).toBe(200);
  });

  it.each(['delivery', 'policy'] as const)(
    'keeps resend responses generic during %s failures',
    async (failure) => {
      const user = await credential();
      state.deliveryFails = failure === 'delivery';
      state.settingsError = failure === 'policy';
      const existing = await request('/send-verification-email', { email: user.email });
      const unknown = await request('/send-verification-email', {
        email: `${randomUUID()}@example.test`,
      });
      expect(existing.status).toBe(unknown.status);
      expect(await existing.json()).toEqual(await unknown.json());
      expect((await stored(user.id)).emailVerified).toBe(false);
    },
  );

  it('uses one policy snapshot for resend instead of a second account-dependent read', async () => {
    const user = await credential();
    state.failRepeatedAuthRead = true;
    state.authReads = 0;
    const existing = await request('/send-verification-email', { email: user.email });
    expect(existing.status).toBe(200);
    expect(state.authReads).toBe(1);
    expect((await stored(user.id)).emailVerified).toBe(false);
    state.authReads = 0;
    const unknown = await request('/send-verification-email', {
      email: `${randomUUID()}@example.test`,
    });
    expect(unknown.status).toBe(200);
    expect(state.authReads).toBe(1);
    expect(await existing.json()).toEqual(await unknown.json());
  });

  it('does not waive verification for a missing real settings row, including pending administrators', async () => {
    const pendingAdmin = await credential('admin');
    const verifiedAdmin = await credential('admin', true);
    state.useStoredAuth = true;
    const resend = await request('/send-verification-email', { email: pendingAdmin.email });
    expect(resend.status).toBe(503);
    expect((await stored(pendingAdmin.id)).emailVerified).toBe(false);
    const signin = await request('/sign-in/email', { email: pendingAdmin.email, password });
    expect(signin.status).toBe(503);
    await expectNoSession(pendingAdmin.id, signin);
    const { response, user } = await signup();
    expect(response.status).toBe(503);
    expect(user).toBeUndefined();
    expect((await request('/sign-in/email', { email: verifiedAdmin.email, password })).status).toBe(
      200,
    );
  });

  it('reports the required policy in public status even without SMTP', async () => {
    state.smtpConfigured = false;
    const { authStatusRoutes } = await import('../../routes/auth-status.js');
    const app = new Hono().route('/auth', authStatusRoutes);
    const response = await app.request('/auth/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emailVerificationRequired: true,
      smtpConfigured: false,
    });
  });

  it('keeps only verified administrator recovery available when local auth is off', async () => {
    const admin = await credential('admin', true);
    const pendingAdmin = await credential('admin');
    const ordinary = await credential('user', true);
    state.localAuth = false;
    state.smtpConfigured = false;
    expect((await request('/sign-in/email', { email: admin.email, password })).status).toBe(200);
    for (const user of [pendingAdmin, ordinary]) {
      const response = await request('/sign-in/email', { email: user.email, password });
      expect(response.status).toBe(403);
      await expectNoSession(user.id, response);
    }
  });

  it('blocks policy-read failures except for verified administrator recovery', async () => {
    const admin = await credential('admin', true);
    const ordinary = await credential('user', true);
    state.settingsError = true;
    const signin = await request('/sign-in/email', { email: ordinary.email, password });
    expect(signin.status).toBe(503);
    await expectNoSession(ordinary.id, signin);
    const { response, user } = await signup();
    expect(response.status).toBe(503);
    expect(user).toBeUndefined();
    expect((await request('/sign-in/email', { email: admin.email, password })).status).toBe(200);
  });

  it('does not leak the recovery exemption into concurrent signup requests', async () => {
    const admin = await credential('admin', true);
    for (let round = 0; round < 3; round++) {
      const [signin, created] = await Promise.all([
        request('/sign-in/email', { email: admin.email, password }),
        signup(),
      ]);
      expect(signin.status).toBe(200);
      expect(created.response.status).toBe(200);
      expect(created.user?.emailVerified).toBe(false);
      await expectNoSession(created.user?.id, created.response);
    }
  });

  it.each(['user', 'admin'] as const)(
    'leaves an administrator-created %s unverified on delivery failure',
    async (role) => {
      const { createUser } = await import('../../services/admin-users/mutations.js');
      const admin = await credential('admin', true);
      state.deliveryFails = true;
      const email = `${randomUUID()}@example.test`;
      const created = await createUser(
        { id: admin.id, email: admin.email },
        { email, password, name: 'Created user', role },
      );
      expect((await stored(created.id)).emailVerified).toBe(false);
      const signin = await request('/sign-in/email', { email, password });
      expect(signin.status).toBe(403);
      await expectNoSession(created.id, signin);
    },
  );

  it.each([false, true])(
    'keeps invite redemption complete and unverified (request throws: %s)',
    async (throws) => {
      const { acceptInvitation } = await import('../../services/invitations.js');
      const { hashToken } = await import('../../lib/crypto.js');
      const token = randomUUID();
      await pool.db.insert(schema.invitation).values({
        organizationId: state.organizationId,
        role: 'user',
        tokenHash: hashToken(token),
      });
      state.registration = 'invite_only';
      state.deliveryFails = true;
      if (throws)
        vi.spyOn(auth.api, 'sendVerificationEmail').mockRejectedValueOnce(
          new Error('Injected verification request failure'),
        );
      const email = `${randomUUID()}@example.test`;
      expect(await acceptInvitation({ token, email, password, name: 'Invited user' })).toEqual({
        emailVerificationRequired: true,
      });
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.email, email));
      expect(user?.emailVerified).toBe(false);
      const [invite] = await pool.db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.tokenHash, hashToken(token)));
      expect(invite?.redeemedByUserId).toBe(user?.id);
      expect((await request('/sign-in/email', { email, password })).status).toBe(403);
    },
  );

  it('retains explicitly disabled verification behavior', async () => {
    state.required = false;
    const { response, user } = await signup();
    expect(response.status).toBe(200);
    expect(user?.emailVerified).toBe(true);
    const signin = await request('/sign-in/email', { email: user!.email, password });
    expect(signin.status).toBe(200);
  });
});
