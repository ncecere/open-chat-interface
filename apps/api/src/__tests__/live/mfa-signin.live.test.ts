import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from '../../../test/live-client.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { redisUrlForDatabase } from '../../../test/redis-database.js';
import { secretFromUri, totp } from '../../../test/totp.js';

/**
 * Two-step verification (v0.14, #399): enrolling an authenticator, signing in
 * with the second step, recovery codes, the limits and the lockout, replay and
 * "trust this device", switching it off. Real PostgreSQL, Redis and Better
 * Auth through the real /api routes (the whole application, so the gate, the
 * limits and the 404s for the plugin's own endpoints are in play); only the
 * SMTP transport is captured. Fresh accounts throughout: the seeded
 * administrator is never enrolled here.
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
        return { messageId: 'mfa' };
      },
    }),
  },
}));

// A database of its own: this file clears the replay claims by pattern, see test/redis-database.ts.
const redisUrl = redisUrlForDatabase(
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6389',
  11,
);
process.env.REDIS_URL = redisUrl;
const available = await livePostgresAvailable();
const password = 'Mfa-live-test-password-123!';
const RECOVERY_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;

describe.skipIf(!available)('live: two-step verification', { timeout: 60_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let redis: Redis;
  let auth: typeof import('../../auth/index.js')['auth'];
  let app: ReturnType<typeof import('../../app.js')['createApp']>;
  let settle: () => Promise<void>;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('mfa_signin');
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
    redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    // The isolation only holds if the application itself uses that database.
    expect((await sharedRedis())?.options.db).toBe(11);
    ({ auth } = await import('../../auth/index.js'));
    ({ settleAccountEmails: settle } = await import('../../services/account-email-delivery.js'));
    const { createApp } = await import('../../app.js');
    app = createApp();
  });
  beforeEach(async () => {
    state.sent.length = 0;
    await pool.db.execute(sql`delete from audit_log`);
    await forgetCodes();
  });
  afterAll(async () => {
    redis?.disconnect();
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  /** Forgets the replay guard's memory, so tests can reuse the three codes a window accepts. */
  async function forgetCodes() {
    const keys = await redis.keys('oci:mfa-code:*');
    if (keys.length > 0) await redis.del(...keys);
    const { resetLocalCodeClaims } = await import('../../services/limits/code-replay.js');
    resetLocalCodeClaims();
  }

  async function person(role: 'user' | 'admin' = 'user') {
    const email = `${randomUUID()}@example.test`;
    const { user } = await auth.api.createUser({
      body: { email, password, name: 'Mfa Fixture', role },
    });
    await pool.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, user.id));
    return { id: user.id, email };
  }

  function browser() {
    return new LiveClient(app, origin);
  }

  async function signIn(client: LiveClient, email: string, pass = password) {
    return client.request<{
      twoFactorRedirect?: boolean;
      twoFactorMethods?: string[];
      code?: string;
    }>('/api/auth/sign-in/email', { json: { email, password: pass } });
  }

  /** Enrols an authenticator through the OCI routes, as the settings page does. */
  async function enrol(client: LiveClient) {
    const begun = await client.request<{ totpURI: string; manualKey: string }>('/api/me/mfa/totp', {
      json: { password },
    });
    expect(begun.status).toBe(200);
    const secret = secretFromUri(begun.body.totpURI);
    expect(begun.body.manualKey).toBe(secret);
    const confirmed = await client.request<{ recoveryCodes: string[] }>(
      '/api/me/mfa/totp/confirm',
      { json: { code: totp(secret) } },
    );
    expect(confirmed.status).toBe(200);
    return { secret, recoveryCodes: confirmed.body.recoveryCodes, begun, confirmed };
  }

  /** A person who is signed in and enrolled (the session is the swapped, `totp` one). */
  async function enrolled() {
    const who = await person();
    const client = browser();
    expect((await signIn(client, who.email)).status).toBe(200);
    const enrolment = await enrol(client);
    return { ...who, client, ...enrolment };
  }

  async function sessionMethod(client: LiveClient): Promise<string | null> {
    const token = decodeURIComponent(client.sessionCookie ?? '').split('.')[0];
    const [row] = await pool.db
      .select({ authMethod: schema.session.authMethod })
      .from(schema.session)
      .where(eq(schema.session.token, token ?? ''));
    return row?.authMethod ?? null;
  }

  async function audit(action: string) {
    return pool.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  }

  async function twoFactorRow(userId: string) {
    const [row] = await pool.db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, userId));
    return row;
  }

  /** Starts a sign-in and returns the client holding the second step's challenge. */
  async function challenged(email: string) {
    const client = browser();
    const response = await signIn(client, email);
    expect(response.status).toBe(200);
    expect(response.body.twoFactorRedirect).toBe(true);
    return client;
  }

  async function verifyTotp(client: LiveClient, code: string, extra: Record<string, unknown> = {}) {
    return client.request<{ code?: string; message?: string }>('/api/auth/two-factor/verify-totp', {
      json: { code, ...extra },
    });
  }

  describe('enrolling', () => {
    it('starts Off, then enrols through the password and a first code, and says what is set up', async () => {
      const who = await person();
      const client = browser();
      await signIn(client, who.email);
      const before = await client.request<Record<string, unknown>>('/api/me/mfa');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        eligible: true,
        enrolled: false,
        methods: [],
        recoveryCodesLeft: null,
        required: false,
        deadline: null,
        limited: false,
        passkeys: [],
        lockedUntil: null,
      });
      expect(before.headers.get('cache-control')).toBe('no-store');

      const started = await client.request<{ totpURI: string; manualKey: string }>(
        '/api/me/mfa/totp',
        { json: { password } },
      );
      expect(started.status).toBe(200);
      expect(started.headers.get('cache-control')).toBe('no-store');
      expect(started.body.totpURI).toMatch(/^otpauth:\/\/totp\//);
      expect(started.body.totpURI).toContain('digits=6');
      expect(started.body.manualKey).toMatch(/^[A-Z2-7]+$/);
      // Not on yet: a pending secret is not a second step.
      expect((await client.request<{ enrolled: boolean }>('/api/me/mfa')).body.enrolled).toBe(
        false,
      );
      const row = await twoFactorRow(who.id);
      expect(row?.verified).toBe(false);

      const sessionBefore = client.sessionCookie;
      const wrong = await client.request<{ error: { code: string; details: unknown } }>(
        '/api/me/mfa/totp/confirm',
        { json: { code: '000000' } },
      );
      expect(wrong.status).toBe(422);
      expect(wrong.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(wrong.body.error.details)).toContain('code');

      const secret = started.body.manualKey;
      const confirmed = await client.request<{ recoveryCodes: string[] }>(
        '/api/me/mfa/totp/confirm',
        { json: { code: totp(secret) } },
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.headers.get('cache-control')).toBe('no-store');
      expect(confirmed.body.recoveryCodes).toHaveLength(10);
      for (const code of confirmed.body.recoveryCodes) expect(code).toMatch(RECOVERY_CODE);
      // The session was replaced (Set-Cookie forwarded) and is the totp one.
      expect(client.sessionCookie).toBeTruthy();
      expect(client.sessionCookie).not.toBe(sessionBefore);
      expect(await sessionMethod(client)).toBe('totp');

      const after = await client.request<Record<string, unknown>>('/api/me/mfa');
      expect(after.body).toMatchObject({
        enrolled: true,
        methods: ['totp'],
        recoveryCodesLeft: 10,
        limited: false,
      });
      const me = await client.request<{ mfa: Record<string, unknown> }>('/api/me');
      expect(me.body.mfa).toMatchObject({
        eligible: true,
        enrolled: true,
        methods: ['totp'],
        recoveryCodesLeft: 10,
      });
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, who.id));
      expect(user?.twoFactorEnabled).toBe(true);
    });

    it('refuses a wrong password, and an authenticator that is already on', async () => {
      const who = await enrolled();
      const again = await who.client.request<{ error: { code: string } }>('/api/me/mfa/totp', {
        json: { password },
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');

      const other = await person();
      const client = browser();
      await signIn(client, other.email);
      const wrong = await client.request<{ error: { code: string; details: unknown } }>(
        '/api/me/mfa/totp',
        { json: { password: 'not-the-password-at-all' } },
      );
      expect(wrong.status).toBe(422);
      expect(JSON.stringify(wrong.body.error.details)).toContain('password');
      expect(await twoFactorRow(other.id)).toBeUndefined();
      // Confirming with nothing waiting is a conflict, not a crash.
      const nothing = await client.request('/api/me/mfa/totp/confirm', {
        json: { code: '123456' },
      });
      expect(nothing.status).toBe(409);
    });

    it('does not let an account with no password enrol (single sign-on only)', async () => {
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
      // A signed session cookie, made by Better Auth itself.
      const context = await auth.$context;
      const { signCookieValue } = await import('../../../test/session-cookie.js');
      const cookie = await signCookieValue(context.secret, session!.token);
      const client = browser();
      client.jar.set('oci.session_token', cookie);
      const status = await client.request<{ eligible: boolean; enrolled: boolean }>('/api/me/mfa');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ eligible: false, enrolled: false });
      const attempt = await client.request('/api/me/mfa/totp', { json: { password } });
      expect(attempt.status).toBe(409);
    });

    it('audits enabling without a secret, a code or a link, and emails the person', async () => {
      const who = await enrolled();
      await settle();
      const [event] = await audit('auth.mfa.enabled');
      expect(event).toMatchObject({ actorUserId: who.id, targetId: who.id });
      expect(event?.metadata).toEqual({ method: 'totp', recoveryCodes: 10 });
      const everything = JSON.stringify(await pool.db.select().from(schema.auditLog));
      expect(everything).not.toContain(who.secret);
      expect(everything).not.toContain('otpauth');
      for (const code of who.recoveryCodes) expect(everything).not.toContain(code);
      expect(
        state.sent.filter((mail) => mail.to === who.email).map((mail) => mail.subject),
      ).toEqual([expect.stringContaining('Two-step verification was turned on')]);
      const text = state.sent.map((mail) => mail.text).join('\n');
      expect(text).not.toContain(who.secret);
    });
  });

  describe('signing in with the second step', () => {
    it('answers the right password with a challenge and no session, and records it as challenged, not as a sign-in', async () => {
      const who = await enrolled();
      // The sign-in before enrolling was an ordinary one; what follows is not.
      const signIns = (await audit('auth.signin.local.success')).length;
      const client = browser();
      const response = await signIn(client, who.email);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
      expect(client.sessionCookie).toBeUndefined();
      expect((await client.request('/api/me')).status).toBe(401);
      expect(await audit('auth.signin.local.challenged')).toHaveLength(1);
      expect(await audit('auth.signin.local.success')).toHaveLength(signIns);
    });

    it('answers a wrong password as it does without a second step, so the second step is not revealed', async () => {
      const who = await enrolled();
      const plain = await person();
      const withStep = await signIn(browser(), who.email, 'wrong-password-123456');
      const without = await signIn(browser(), plain.email, 'wrong-password-123456');
      expect(withStep.status).toBe(401);
      expect(without.status).toBe(401);
      expect(withStep.body).toEqual(without.body);
      const unknown = await signIn(
        browser(),
        `${randomUUID()}@example.test`,
        'wrong-password-123456',
      );
      expect(unknown.status).toBe(401);
    });

    it('signs in with a code, records the method, and audits the verification', async () => {
      const who = await enrolled();
      const client = await challenged(who.email);
      // The enrolment used this window's code; the next window's is accepted too (window 1).
      const response = await verifyTotp(client, totp(who.secret, { stepOffset: 1 }));
      expect(response.status).toBe(200);
      expect(client.sessionCookie).toBeTruthy();
      expect(await sessionMethod(client)).toBe('totp');
      expect((await client.request('/api/me')).status).toBe(200);
      const [success] = await audit('auth.mfa.verify.success');
      expect(success?.actorUserId).toBe(who.id);
      expect(success?.metadata).toMatchObject({ method: 'totp' });
      expect(JSON.stringify(success)).not.toContain(totp(who.secret, { stepOffset: 1 }));
    });

    it('accepts a code with a space in it, as people type them', async () => {
      const who = await enrolled();
      const client = await challenged(who.email);
      const code = totp(who.secret, { stepOffset: -1 });
      const response = await verifyTotp(client, `${code.slice(0, 3)} ${code.slice(3)}`);
      expect(response.status).toBe(200);
    });

    it('refuses a wrong code, with the plugin code and audit, and the challenge stays', async () => {
      const who = await enrolled();
      const client = await challenged(who.email);
      const wrong = await verifyTotp(client, '000000');
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CODE');
      expect(client.sessionCookie).toBeUndefined();
      const [failure] = await audit('auth.mfa.verify.failure');
      expect(failure?.actorUserId).toBe(who.id);
      expect(failure?.metadata).toMatchObject({ method: 'totp', reason: 'INVALID_CODE' });
      // The same challenge still works with the right code.
      expect((await verifyTotp(client, totp(who.secret, { stepOffset: 1 }))).status).toBe(200);
    });

    it('answers an unknown and an expired challenge with one error', async () => {
      const client = browser();
      const none = await verifyTotp(client, '123456');
      expect(none.status).toBe(401);
      expect(none.body.code).toBe('INVALID_TWO_FACTOR_COOKIE');
      const who = await enrolled();
      const challenge = await challenged(who.email);
      await pool.db.execute(
        sql`update verification set expires_at = now() - interval '1 minute' where identifier like '2fa-%'`,
      );
      const expired = await verifyTotp(challenge, totp(who.secret, { stepOffset: 1 }));
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe('INVALID_TWO_FACTOR_COOKIE');
    });

    it('refuses a code that was just used, even though it is still valid, and a typing mistake is not a replay', async () => {
      const who = await enrolled();
      const code = totp(who.secret, { stepOffset: 1 });
      const first = await challenged(who.email);
      // A wrong code first: it must not be remembered.
      expect((await verifyTotp(first, '999999')).status).toBe(401);
      expect((await verifyTotp(first, code)).status).toBe(200);

      const second = await challenged(who.email);
      const replay = await verifyTotp(second, code);
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('CODE_ALREADY_USED');
      expect(second.sessionCookie).toBeUndefined();
      // The next window's code is not a replay.
      expect((await verifyTotp(second, totp(who.secret, { stepOffset: -1 }))).status).toBe(200);
    });

    it('lets exactly one of two parallel uses of the same code win', async () => {
      const who = await enrolled();
      const code = totp(who.secret, { stepOffset: 1 });
      const [a, b] = await Promise.all([challenged(who.email), challenged(who.email)]);
      const results = await Promise.all([verifyTotp(a, code), verifyTotp(b, code)]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    });

    it('ignores "trust this device": no cookie, and the next sign-in is challenged again', async () => {
      const who = await enrolled();
      const client = await challenged(who.email);
      const response = await verifyTotp(client, totp(who.secret, { stepOffset: 1 }), {
        trustDevice: true,
      });
      expect(response.status).toBe(200);
      expect([...client.jar.keys()].some((name) => name.includes('trust_device'))).toBe(false);
      expect(response.headers.getSetCookie().join(';')).not.toContain('trust_device');
      const rows = await pool.db.execute(
        sql`select count(*)::int as n from verification where identifier like 'trust-device-%'`,
      );
      expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
      client.jar.delete('oci.session_token');
      const again = await signIn(client, who.email);
      expect(again.body.twoFactorRedirect).toBe(true);
    });
  });

  describe('the way in that is not the password', () => {
    it('does not sign in, by the first verification of an address, somebody who has the second step on', async () => {
      const { createEmailVerificationToken } = await import('better-auth/api');
      const secret = (await auth.$context).secret;
      const who = await enrolled();
      await pool.db
        .update(schema.user)
        .set({ emailVerified: false })
        .where(eq(schema.user.id, who.id));
      const link = `/api/auth/verify-email?token=${await createEmailVerificationToken(secret, who.email)}`;
      const client = browser();
      const response = await client.request(link);
      expect(response.status).toBeLessThan(400);
      expect(client.sessionCookie).toBeUndefined();
      const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, who.id));
      expect(user?.emailVerified).toBe(true);
      // The same link for somebody without it still signs in, as before (the control).
      const plain = await person();
      await pool.db
        .update(schema.user)
        .set({ emailVerified: false })
        .where(eq(schema.user.id, plain.id));
      const control = browser();
      await control.request(
        `/api/auth/verify-email?token=${await createEmailVerificationToken(secret, plain.email)}`,
      );
      expect(control.sessionCookie).toBeTruthy();
      expect(await sessionMethod(control)).toBe('other');
    });
  });

  describe('recovery codes', () => {
    it('signs in once with a recovery code, says how many are left, and refuses it the second time', async () => {
      const who = await enrolled();
      const [code] = who.recoveryCodes;
      const client = await challenged(who.email);
      const response = await client.request('/api/auth/two-factor/verify-backup-code', {
        json: { code },
      });
      expect(response.status).toBe(200);
      expect(await sessionMethod(client)).toBe('recovery_code');
      await settle();
      const [used] = await audit('auth.mfa.recovery_code.used');
      expect(used?.metadata).toEqual({ remaining: 9 });
      expect(JSON.stringify(await pool.db.select().from(schema.auditLog))).not.toContain(
        code ?? '??',
      );
      const mail = state.sent.find((message) =>
        message.subject.includes('A recovery code was used'),
      );
      expect(mail?.to).toBe(who.email);
      expect(mail?.text).toContain('You have 9 recovery codes left');
      expect(mail?.text).not.toContain(code ?? '??');
      expect(
        (await client.request<{ mfa: { recoveryCodesLeft: number } }>('/api/me')).body.mfa
          .recoveryCodesLeft,
      ).toBe(9);

      const again = await challenged(who.email);
      const reused = await again.request<{ code: string }>(
        '/api/auth/two-factor/verify-backup-code',
        {
          json: { code },
        },
      );
      expect(reused.status).toBe(401);
      // Within two minutes OCI's claim answers; the plugin's own answer is behind it.
      expect(reused.body.code).toBe('CODE_ALREADY_USED');
      await forgetCodes();
      const gone = await (await challenged(who.email)).request<{ code: string }>(
        '/api/auth/two-factor/verify-backup-code',
        { json: { code } },
      );
      expect(gone.status).toBe(401);
      expect(gone.body.code).toBe('INVALID_BACKUP_CODE');
    });

    it('accepts ten pasted characters without the hyphen and surrounding spaces, and nothing else', async () => {
      const who = await enrolled();
      const [code, other] = who.recoveryCodes as [string, string];
      const client = await challenged(who.email);
      const pasted = ` ${code.replace('-', '')} `;
      expect(
        (
          await client.request('/api/auth/two-factor/verify-backup-code', {
            json: { code: pasted },
          })
        ).status,
      ).toBe(200);
      // Case matters: the wrong case is a different code.
      const wrongCase = await challenged(who.email);
      const swapped = other
        .replace(/[a-z]/g, (c) => c.toUpperCase())
        .replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (swapped !== other) {
        const response = await wrongCase.request('/api/auth/two-factor/verify-backup-code', {
          json: { code: swapped },
        });
        expect(response.status).toBe(401);
      }
    });

    it('lets exactly one of two parallel uses of a recovery code win, every time', async () => {
      // The plugin's own guard does not hold under concurrency with the Drizzle
      // adapter (a guarded UPDATE ... WHERE id IN (SELECT ...) passes twice under
      // READ COMMITTED): about one pair in four spent a code twice before OCI's
      // claim (services/limits/code-replay.ts). Enough pairs to see it.
      for (let trial = 0; trial < 12; trial++) {
        const who = await enrolled();
        const [code] = who.recoveryCodes;
        const [a, b] = await Promise.all([challenged(who.email), challenged(who.email)]);
        const results = await Promise.all(
          [a, b].map((client) =>
            client.request('/api/auth/two-factor/verify-backup-code', { json: { code } }),
          ),
        );
        const statuses = results.map((result) => result.status).sort();
        expect(statuses, `trial ${trial}`).toEqual([200, expect.any(Number)]);
        expect([401, 409], `trial ${trial}`).toContain(statuses[1]);
        // And the code is gone: nine are left, not ten.
        const left = await a.request<{ mfa: { recoveryCodesLeft: number } }>('/api/me');
        const winner = results[0]?.status === 200 ? a : b;
        expect(
          (await winner.request<{ mfa: { recoveryCodesLeft: number } }>('/api/me')).body.mfa
            .recoveryCodesLeft,
          `trial ${trial} ${left.status}`,
        ).toBe(9);
      }
    });

    it('regenerates with the password and a current code, and the old codes stop working', async () => {
      const who = await enrolled();
      const oldCode = who.recoveryCodes[0];
      const refused = await who.client.request<{ error: { code: string } }>(
        '/api/me/mfa/recovery-codes',
        {
          json: { password, code: '000000' },
        },
      );
      expect(refused.status).toBe(422);
      const wrongPassword = await who.client.request('/api/me/mfa/recovery-codes', {
        json: { password: 'not-the-password-at-all', code: totp(who.secret, { stepOffset: 1 }) },
      });
      expect(wrongPassword.status).toBe(422);

      const regenerated = await who.client.request<{ recoveryCodes: string[] }>(
        '/api/me/mfa/recovery-codes',
        {
          json: { password, code: totp(who.secret, { stepOffset: 1 }) },
        },
      );
      expect(regenerated.status).toBe(200);
      expect(regenerated.headers.get('cache-control')).toBe('no-store');
      expect(regenerated.body.recoveryCodes).toHaveLength(10);
      expect(regenerated.body.recoveryCodes).not.toContain(oldCode);
      const client = await challenged(who.email);
      const old = await client.request('/api/auth/two-factor/verify-backup-code', {
        json: { code: oldCode },
      });
      expect(old.status).toBe(401);
      const fresh = await client.request('/api/auth/two-factor/verify-backup-code', {
        json: { code: regenerated.body.recoveryCodes[0] },
      });
      expect(fresh.status).toBe(200);
      expect(await audit('auth.mfa.recovery_codes.regenerated')).toHaveLength(1);
    });

    it('takes a recovery code in place of the authenticator code to regenerate', async () => {
      const who = await enrolled();
      const response = await who.client.request<{ recoveryCodes: string[] }>(
        '/api/me/mfa/recovery-codes',
        {
          json: { password, code: who.recoveryCodes[0] },
        },
      );
      expect(response.status).toBe(200);
    });

    it('never shows stored codes again: the status carries only the count', async () => {
      const who = await enrolled();
      const status = await who.client.request('/api/me/mfa');
      expect(status.text).not.toContain(who.recoveryCodes[0] ?? '??');
      expect(status.text).not.toContain(who.secret);
      expect(Object.keys(status.body as object)).not.toContain('recoveryCodes');
    });
  });

  describe('limits and the lockout', () => {
    it('ends a challenge after five wrong codes, even for the right one', async () => {
      const who = await enrolled();
      const client = await challenged(who.email);
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await verifyTotp(client, `00000${attempt}`)).status).toBe(401);
      }
      const sixth = await verifyTotp(client, totp(who.secret, { stepOffset: 1 }));
      expect(sixth.status).toBe(400);
      expect(sixth.body.code).toBe('TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE');
      expect(client.sessionCookie).toBeUndefined();
    });

    it('locks the second step at ten consecutive failures across challenges, and unlocking clears it', async () => {
      const who = await enrolled();
      for (let challenge = 0; challenge < 2; challenge++) {
        const client = await challenged(who.email);
        for (let attempt = 0; attempt < 5; attempt++) {
          expect((await verifyTotp(client, `11111${attempt}${challenge}`.slice(0, 6))).status).toBe(
            401,
          );
        }
      }
      const locked = await twoFactorRow(who.id);
      expect(locked?.failedVerificationCount).toBeGreaterThanOrEqual(10);
      expect(locked?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

      const client = await challenged(who.email);
      const refused = await verifyTotp(client, totp(who.secret, { stepOffset: 1 }));
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
      const { clearSecondStepFailures } = await import('../../services/mfa/lockout.js');
      await clearSecondStepFailures(who.id);
      const retry = await challenged(who.email);
      expect((await verifyTotp(retry, totp(who.secret, { stepOffset: 1 }))).status).toBe(200);
    });

    it('limits wrong codes per challenge in a burst: 429 with Retry-After, audited once', async () => {
      const who = await person();
      const client = browser();
      await signIn(client, who.email);
      // A pending enrolment, confirmed with wrong codes: the signed-in path counts nothing in the plugin.
      await client.request('/api/me/mfa/totp', { json: { password } });
      const statuses: number[] = [];
      let limited: Awaited<ReturnType<typeof client.request>> | null = null;
      for (let attempt = 0; attempt < 9; attempt++) {
        const response = await client.request('/api/me/mfa/totp/confirm', {
          json: { code: `20000${attempt}` },
        });
        statuses.push(response.status);
        if (response.status === 429 && !limited) limited = response;
      }
      expect(statuses.slice(0, 6)).toEqual([422, 422, 422, 422, 422, 422]);
      expect(statuses.slice(6).every((status) => status === 429)).toBe(true);
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await audit('auth.rate_limited')).toHaveLength(1);
    });

    it('counts wrong codes to disable or regenerate toward the lockout, so a stolen session is not an oracle', async () => {
      const who = await enrolled();
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await who.client.request('/api/me/mfa/recovery-codes', {
          json: { password, code: `30000${attempt}` },
        });
        expect(response.status).toBe(422);
      }
      expect((await twoFactorRow(who.id))?.failedVerificationCount).toBe(5);
      // A right code clears the count.
      const ok = await who.client.request('/api/me/mfa/recovery-codes', {
        json: { password, code: totp(who.secret, { stepOffset: 1 }) },
      });
      expect(ok.status).toBe(200);
      expect((await twoFactorRow(who.id))?.failedVerificationCount).toBe(0);
    });

    it('refuses to disable or regenerate while the second step is locked', async () => {
      const who = await enrolled();
      await pool.db
        .update(schema.twoFactor)
        .set({ failedVerificationCount: 10, lockedUntil: new Date(Date.now() + 10 * 60_000) })
        .where(eq(schema.twoFactor.userId, who.id));
      const response = await who.client.request('/api/me/mfa/totp/disable', {
        json: { password, code: totp(who.secret, { stepOffset: 1 }) },
      });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(
        (await who.client.request<{ lockedUntil: string | null }>('/api/me/mfa')).body.lockedUntil,
      ).not.toBeNull();
    });
  });

  describe('turning it off', () => {
    it('needs the password and a current code, swaps the session, and the next sign-in is not challenged', async () => {
      const who = await enrolled();
      const noCode = await who.client.request('/api/me/mfa/totp/disable', { json: { password } });
      expect(noCode.status).toBe(422);
      const wrongPassword = await who.client.request('/api/me/mfa/totp/disable', {
        json: { password: 'not-the-password-at-all', code: totp(who.secret, { stepOffset: 1 }) },
      });
      expect(wrongPassword.status).toBe(422);
      const wrongCode = await who.client.request('/api/me/mfa/totp/disable', {
        json: { password, code: '000000' },
      });
      expect(wrongCode.status).toBe(422);
      expect((await twoFactorRow(who.id))?.verified).toBe(true);

      const before = who.client.sessionCookie;
      const disabled = await who.client.request<{ ok: boolean }>('/api/me/mfa/totp/disable', {
        json: { password, code: totp(who.secret, { stepOffset: 1 }) },
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body).toEqual({ ok: true });
      expect(who.client.sessionCookie).not.toBe(before);
      expect(await sessionMethod(who.client)).toBe('other');
      expect(await twoFactorRow(who.id)).toBeUndefined();
      expect((await who.client.request<{ enrolled: boolean }>('/api/me/mfa')).body.enrolled).toBe(
        false,
      );
      const [disabledEvent] = await audit('auth.mfa.disabled');
      expect(disabledEvent?.metadata).toEqual({ method: 'totp' });

      const next = await signIn(browser(), who.email);
      expect(next.body.twoFactorRedirect).toBeUndefined();
      await settle();
      expect(state.sent.map((mail) => mail.subject).join('\n')).toContain('turned off');
    });

    it('takes a recovery code to disable, too', async () => {
      const who = await enrolled();
      const disabled = await who.client.request('/api/me/mfa/totp/disable', {
        json: { password, code: who.recoveryCodes[0] },
      });
      expect(disabled.status).toBe(200);
      expect(await twoFactorRow(who.id)).toBeUndefined();
    });

    it('can be set up again afterwards with a new secret', async () => {
      const who = await enrolled();
      await who.client.request('/api/me/mfa/totp/disable', {
        json: { password, code: totp(who.secret, { stepOffset: 1 }) },
      });
      const again = await enrol(who.client);
      expect(again.secret).not.toBe(who.secret);
    });
  });

  describe('what the browser cannot reach', () => {
    it.each([
      ['POST', '/api/auth/two-factor/enable', { password }],
      ['POST', '/api/auth/two-factor/disable', { password }],
      ['POST', '/api/auth/two-factor/get-totp-uri', { password }],
      ['POST', '/api/auth/two-factor/generate-backup-codes', { password }],
      ['POST', '/api/auth/two-factor/send-otp', {}],
      ['POST', '/api/auth/two-factor/verify-otp', { code: '123456' }],
      ['GET', '/api/auth/passkey/list-user-passkeys', undefined],
    ] as const)('%s %s answers 404 even with a session', async (method, path, json) => {
      const who = await enrolled();
      const response = await who.client.request<{ error: { code: string } }>(path, {
        method,
        json,
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      // And nothing changed: the authenticator is still on.
      expect((await twoFactorRow(who.id))?.verified).toBe(true);
    });
  });

  describe('storage', () => {
    it('keeps the secret and the recovery codes encrypted, not as typed', async () => {
      const who = await enrolled();
      const row = await twoFactorRow(who.id);
      expect(row?.secret).toBeTruthy();
      expect(row?.secret).not.toContain(who.secret);
      expect(row?.backupCodes).not.toContain(who.recoveryCodes[0] ?? '??');
    });

    it('removes everything with the account', async () => {
      const who = await enrolled();
      await pool.db.delete(schema.user).where(eq(schema.user.id, who.id));
      expect(await twoFactorRow(who.id)).toBeUndefined();
    });
  });
});
