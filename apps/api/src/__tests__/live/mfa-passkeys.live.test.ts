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
 * Passkeys (v0.14, #399): registering, signing in, renaming and removing through
 * the real @better-auth/passkey plugin and @simplewebauthn/server verification,
 * with a software authenticator. OCI's rules around it: only accounts with a
 * password may add one, registration needs a fresh session, a passkey must have
 * verified the user (a PIN-less key is two factors in name only), and a passkey
 * sign-in follows the password's local rules. The list is OCI's and never carries
 * the public key or the counter.
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
        return { messageId: 'passkey' };
      },
    }),
  },
}));

const available = await livePostgresAvailable();
const password = 'Mfa-passkey-test-password-123!';

describe.skipIf(!available)('live: passkeys', { timeout: 60_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];
  let app: ReturnType<typeof import('../../app.js')['createApp']>;
  let updateSetting: typeof import('../../services/settings.js')['updateSetting'];
  let settle: () => Promise<void>;
  const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;
  const rpId = new URL(origin).hostname;

  beforeAll(async () => {
    live = await createLiveDatabase('mfa_passkeys');
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
    await updateSetting('auth', { localAuthEnabled: true, emailVerificationRequired: false });
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  const browser = () => new LiveClient(app, origin);

  async function person(overrides: { role?: 'user' | 'admin'; verified?: boolean } = {}) {
    const email = `${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, password, name: 'Passkey Fixture', role: overrides.role ?? 'user' },
    });
    await pool.db
      .update(schema.user)
      .set({ emailVerified: overrides.verified ?? true })
      .where(eq(schema.user.id, user.id));
    return { id: user.id, email };
  }

  async function signedIn(overrides: Parameters<typeof person>[0] = {}) {
    const who = await person(overrides);
    const client = browser();
    const response = await client.request('/api/auth/sign-in/email', {
      json: { email: who.email, password },
    });
    expect(response.status).toBe(200);
    return { ...who, client };
  }

  async function addPasskey(
    client: LiveClient,
    authenticator: SoftwareAuthenticator,
    name = 'Laptop',
  ) {
    const options = await client.request<RegistrationOptionsJSON>(
      `/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}`,
    );
    expect(options.status).toBe(200);
    return client.request<{ id: string; credentialID: string }>(
      '/api/auth/passkey/verify-registration',
      { json: { response: authenticator.register(options.body), name } },
    );
  }

  async function passkeySignIn(authenticator: SoftwareAuthenticator) {
    const client = browser();
    const options = await client.request<AuthenticationOptionsJSON>(
      '/api/auth/passkey/generate-authenticate-options',
    );
    expect(options.status).toBe(200);
    const response = await client.request<{ code?: string; message?: string }>(
      '/api/auth/passkey/verify-authentication',
      { json: { response: authenticator.authenticate(options.body) } },
    );
    return { client, response };
  }

  async function sessionMethod(client: LiveClient): Promise<string | null> {
    const token = decodeURIComponent(client.sessionCookie ?? '').split('.')[0];
    const [row] = await pool.db
      .select({ authMethod: schema.session.authMethod })
      .from(schema.session)
      .where(eq(schema.session.token, token ?? ''));
    return row?.authMethod ?? null;
  }

  const audit = (action: string) =>
    pool.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  const keyFor = (userVerified = true) => new SoftwareAuthenticator({ origin, rpId, userVerified });

  describe('registering and listing', () => {
    it('adds a passkey with a fresh session, lists it without the key or the counter, and audits and emails it', async () => {
      const who = await signedIn();
      const authenticator = keyFor();
      const added = await addPasskey(who.client, authenticator, 'Work laptop');
      expect(added.status).toBe(200);

      const status = await who.client.request<{
        enrolled: boolean;
        methods: string[];
        passkeys: Array<Record<string, unknown>>;
      }>('/api/me/mfa');
      expect(status.body.enrolled).toBe(true);
      expect(status.body.methods).toEqual(['passkey']);
      expect(status.body.passkeys).toHaveLength(1);
      expect(Object.keys(status.body.passkeys[0] ?? {}).sort()).toEqual([
        'backedUp',
        'createdAt',
        'deviceType',
        'id',
        'name',
      ]);
      expect(status.body.passkeys[0]).toMatchObject({ name: 'Work laptop', backedUp: false });
      expect(status.text).not.toContain('publicKey');
      expect(status.text).not.toContain('counter');
      expect(status.text).not.toContain(authenticator.id);

      const [event] = await audit('auth.passkey.added.success');
      expect(event?.actorUserId).toBe(who.id);
      await settle();
      expect(state.sent.map((mail) => mail.subject).join('\n')).toContain('A passkey was added');
    });

    it('labels an unnamed passkey by its authenticator when it is known, else "Passkey"', async () => {
      const who = await signedIn();
      const known = new SoftwareAuthenticator({
        origin,
        rpId,
        aaguid: Buffer.from('08987058cadc4b81b6e130de50dcbe96', 'hex'),
      });
      const options = await who.client.request<RegistrationOptionsJSON>(
        '/api/auth/passkey/generate-register-options',
      );
      await who.client.request('/api/auth/passkey/verify-registration', {
        json: { response: known.register(options.body) },
      });
      const status = await who.client.request<{ passkeys: Array<{ name: string }> }>('/api/me/mfa');
      expect(status.body.passkeys[0]?.name).toBe('Windows Hello');
    });

    it('answers 403 SESSION_NOT_FRESH for a session older than 24 hours', async () => {
      const who = await signedIn();
      await pool.db
        .update(schema.session)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(schema.session.userId, who.id));
      const response = await who.client.request<{ code: string }>(
        '/api/auth/passkey/generate-register-options',
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('SESSION_NOT_FRESH');
    });

    it('does not let a single sign-on account add one', async () => {
      const userId = await seedUser(pool.db, state.organizationId);
      await pool.db.insert(schema.account).values({
        id: randomUUID(),
        userId,
        accountId: `sub-${userId}`,
        providerId: 'campus-idp',
      });
      const [session] = await pool.db
        .insert(schema.session)
        .values({
          id: randomUUID(),
          userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          authMethod: 'sso',
        })
        .returning();
      const client = browser();
      client.jar.set(
        'oci.session_token',
        await signCookieValue((await auth.$context).secret, session!.token),
      );
      const response = await client.request<{ code: string }>(
        '/api/auth/passkey/generate-register-options',
      );
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PASSKEY_NOT_AVAILABLE');
      const registered = await client.request('/api/auth/passkey/verify-registration', {
        json: { response: {} },
      });
      expect(registered.status).toBe(409);
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId)),
      ).toHaveLength(0);
    });

    it('needs a session', async () => {
      const response = await browser().request('/api/auth/passkey/generate-register-options');
      expect(response.status).toBe(401);
    });
  });

  describe('signing in', () => {
    it('signs in with a passkey: a full sign-in with the passkey method, no password and no second step', async () => {
      const who = await signedIn();
      const authenticator = keyFor();
      await addPasskey(who.client, authenticator);
      // A person who also has an authenticator is not asked for it: the passkey is both.
      const enabled = await who.client.request<{ totpURI: string }>('/api/me/mfa/totp', {
        json: { password },
      });
      await who.client.request('/api/me/mfa/totp/confirm', {
        json: { code: totp(secretFromUri(enabled.body.totpURI)) },
      });

      const { client, response } = await passkeySignIn(authenticator);
      expect(response.status).toBe(200);
      expect(client.sessionCookie).toBeTruthy();
      expect(await sessionMethod(client)).toBe('passkey');
      const me = await client.request<{ user: { id: string } }>('/api/me');
      expect(me.body.user.id).toBe(who.id);
      const [success] = await audit('auth.passkey.signin.success');
      expect(success?.actorUserId).toBe(who.id);
      expect(success?.metadata).toMatchObject({ method: 'passkey' });
    });

    it('refuses a passkey that did not verify the user (a key that only proved presence)', async () => {
      const who = await signedIn();
      const pinless = keyFor(false);
      await addPasskey(who.client, pinless);
      const { client, response } = await passkeySignIn(pinless);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('USER_VERIFICATION_REQUIRED');
      expect(client.sessionCookie).toBeUndefined();
      const [failure] = await audit('auth.passkey.signin.failure');
      expect(failure?.metadata).toMatchObject({ reason: 'USER_VERIFICATION_REQUIRED' });
    });

    it('refuses an unknown passkey, and a challenge used twice', async () => {
      const stranger = keyFor();
      const { response } = await passkeySignIn(stranger);
      expect(response.status).toBe(401);
      const who = await signedIn();
      const authenticator = keyFor();
      await addPasskey(who.client, authenticator);
      const client = browser();
      const options = await client.request<AuthenticationOptionsJSON>(
        '/api/auth/passkey/generate-authenticate-options',
      );
      const assertion = authenticator.authenticate(options.body);
      expect(
        (
          await client.request('/api/auth/passkey/verify-authentication', {
            json: { response: assertion },
          })
        ).status,
      ).toBe(200);
      const replay = await client
        .clone()
        .request<{ code: string }>('/api/auth/passkey/verify-authentication', {
          json: { response: assertion },
        });
      expect(replay.status).toBe(400);
    });

    it("follows the password's local rules: local sign-in off, an unverified address", async () => {
      const who = await signedIn();
      const authenticator = keyFor();
      await addPasskey(who.client, authenticator);

      await updateSetting('auth', { localAuthEnabled: false });
      const off = await passkeySignIn(authenticator);
      expect(off.response.status).toBe(403);
      expect(off.response.body.code).toBe('LOCAL_AUTH_DISABLED');
      expect(off.client.sessionCookie).toBeUndefined();

      await updateSetting('auth', { localAuthEnabled: true, emailVerificationRequired: true });
      await pool.db
        .update(schema.user)
        .set({ emailVerified: false })
        .where(eq(schema.user.id, who.id));
      const unverified = await passkeySignIn(authenticator);
      expect(unverified.response.status).toBe(403);
      expect(unverified.response.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('keeps the break-glass path for a verified administrator while local sign-in is off', async () => {
      const who = await signedIn({ role: 'admin' });
      const authenticator = keyFor();
      await addPasskey(who.client, authenticator);
      await updateSetting('auth', { localAuthEnabled: false });
      const { response } = await passkeySignIn(authenticator);
      expect(response.status).toBe(200);
    });

    it('refuses a banned person', async () => {
      const who = await signedIn();
      const authenticator = keyFor();
      await addPasskey(who.client, authenticator);
      await pool.db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, who.id));
      const { client, response } = await passkeySignIn(authenticator);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('BANNED_USER');
      expect(client.sessionCookie).toBeUndefined();
    });
  });

  describe('managing', () => {
    it('renames and removes a passkey, owner only, audited with the passkey named', async () => {
      const who = await signedIn();
      const authenticator = keyFor();
      const added = await addPasskey(who.client, authenticator, 'Old name');
      const id = added.body.id;

      const stranger = await signedIn();
      const refused = await stranger.client.request('/api/auth/passkey/update-passkey', {
        json: { id, name: 'Mine now' },
      });
      expect([401, 403, 404]).toContain(refused.status);
      const refusedRemoval = await stranger.client.request('/api/auth/passkey/delete-passkey', {
        json: { id },
      });
      expect([401, 403, 404]).toContain(refusedRemoval.status);
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.id, id)),
      ).toHaveLength(1);

      const renamed = await who.client.request('/api/auth/passkey/update-passkey', {
        json: { id, name: 'New name' },
      });
      expect(renamed.status).toBe(200);
      expect(
        (await who.client.request<{ passkeys: Array<{ name: string }> }>('/api/me/mfa')).body
          .passkeys[0]?.name,
      ).toBe('New name');
      const [renamedEvent] = await audit('auth.passkey.renamed.success');
      expect(renamedEvent?.targetId).toBe(id);

      const removed = await who.client.request('/api/auth/passkey/delete-passkey', {
        json: { id },
      });
      expect(removed.status).toBe(200);
      const status = await who.client.request<{ enrolled: boolean; passkeys: unknown[] }>(
        '/api/me/mfa',
      );
      expect(status.body).toMatchObject({ enrolled: false, passkeys: [] });
      const [removedEvent] = await audit('auth.passkey.removed.success');
      expect(removedEvent?.targetId).toBe(id);
      await settle();
      expect(state.sent.map((mail) => mail.subject).join('\n')).toContain('A passkey was removed');
      // A removed passkey no longer signs in.
      expect((await passkeySignIn(authenticator)).response.status).toBe(401);
    });

    it("never lists or reads the plugin's own passkey list over HTTP", async () => {
      const who = await signedIn();
      await addPasskey(who.client, keyFor());
      const response = await who.client.request('/api/auth/passkey/list-user-passkeys');
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('publicKey');
    });

    it('removes passkeys with the account', async () => {
      const who = await signedIn();
      await addPasskey(who.client, keyFor());
      await pool.db.delete(schema.user).where(eq(schema.user.id, who.id));
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, who.id)),
      ).toHaveLength(0);
    });
  });
});
