import { randomUUID } from 'node:crypto';
import { createDatabase } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * Signing in before verifying sends a new link, and Resend straight after it
 * sent a duplicate: three links in 25 seconds, all valid for an hour (#330).
 * A verification email is now sent at most once a minute per account,
 * counted from delivery. Better Auth's real handler, the real policy hooks
 * and email module, a live database; only the SMTP transport is captured.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
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
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Fix7 Verify' }));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'auth')
      return {
        registrationMode: 'open',
        localAuthEnabled: true,
        emailVerificationRequired: true,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    if (key === 'smtp')
      return {
        host: 'mail.example.test',
        port: 587,
        secure: false,
        fromAddress: 'oci@example.test',
        username: null,
        encryptedPassword: null,
      };
    return {};
  },
}));
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
const password = 'Fix7-verify-password-1234';

describe.skipIf(!available)('live: one verification email at a time (#330)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let auth: typeof import('../../auth/index.js')['auth'];

  beforeAll(async () => {
    live = await createLiveDatabase('verification_dedupe');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    ({ auth } = await import('../../auth/index.js'));
  });
  beforeEach(() => {
    state.deliveryFails = false;
    state.mail = [];
  });
  afterAll(async () => {
    const { settleAccountEmails } = await import('../../services/account-email-delivery.js');
    await settleAccountEmails();
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
  async function unverified() {
    const email = `fix7-verify-${randomUUID().slice(0, 8)}@example.test`;
    await auth.api.createUser({ body: { email, password, name: 'Fix7 Verify' } });
    return email;
  }
  /** Lets the background sends started so far finish. */
  async function settled() {
    const { settleAccountEmails } = await import('../../services/account-email-delivery.js');
    await settleAccountEmails();
  }

  it('sends one link for a refused sign-in followed at once by Resend and another sign-in', async () => {
    const email = await unverified();
    const signin = await request('/sign-in/email', { email, password });
    expect(signin.status).toBe(403);
    expect(await signin.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await settled();
    expect(state.mail).toHaveLength(1);

    const resend = await request('/send-verification-email', { email, callbackURL: '/' });
    // The answer is the usual one; it says nothing about what was sent.
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ status: true });
    expect((await request('/sign-in/email', { email, password })).status).toBe(403);
    await settled();
    expect(state.mail).toHaveLength(1);
    expect(state.mail[0]!.to).toBe(email);
  });

  it('does not hold back the next request after a send that failed', async () => {
    const email = await unverified();
    state.deliveryFails = true;
    expect((await request('/sign-in/email', { email, password })).status).toBe(403);
    await settled();
    expect(state.mail).toHaveLength(0);

    state.deliveryFails = false;
    expect((await request('/send-verification-email', { email, callbackURL: '/' })).status).toBe(
      200,
    );
    await settled();
    expect(state.mail).toHaveLength(1);
  });

  it('keeps each account separate', async () => {
    const [first, second] = [await unverified(), await unverified()];
    await request('/sign-in/email', { email: first, password });
    await request('/sign-in/email', { email: second, password });
    await settled();
    expect(state.mail.map((mail) => mail.to).sort()).toEqual([first, second].sort());
  });
});
