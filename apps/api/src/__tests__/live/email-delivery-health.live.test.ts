import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeSmtp, refusingPort, startFakeSmtp } from '../../../test/fake-smtp.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * While email cannot be sent, System health says so, with when and why, and
 * account emails are tried again once the mail server is back (#327). It
 * said "Sending through <host>" through a whole outage, and nothing failed
 * was ever sent. Real nodemailer, a real live database and System health's
 * real route; the mail server is a local port that refuses, then a fake SMTP
 * server started on that same port.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', smtpPort: 0 }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Fix7 Mail' }));
vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...actual,
    getSetting: async (key: string) =>
      key === 'smtp'
        ? {
            host: '127.0.0.1',
            port: state.smtpPort,
            secure: false,
            fromAddress: 'oci@example.test',
            username: null,
            encryptedPassword: null,
          }
        : actual.getSetting(key as never),
  };
});

const available = await livePostgresAvailable();

describe.skipIf(!available)('live: email delivery failures (#327)', () => {
  let live: LiveDatabase;
  let server: FakeSmtp | null = null;
  let app: Hono;

  beforeAll(async () => {
    live = await createLiveDatabase('email_delivery_health');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const { healthRoutes } = await import('../../routes/admin/health.js');
    app = new Hono().route('/health', healthRoutes);
  });
  beforeEach(async () => {
    state.smtpPort = await refusingPort();
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    const { setAccountEmailRetryDelays } = await import('../../services/account-email-delivery.js');
    setAccountEmailRetryDelays(null);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  async function emailRow() {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    return body.checks.find((check) => check.id === 'email')!;
  }

  it('says the latest emails failed, when and why, until one is delivered again', async () => {
    const { sendInviteEmail, sendPasswordResetEmail } = await import('../../services/email.js');
    const started = new Date();
    expect(
      await sendPasswordResetEmail({ to: 'fix7-a@example.test', url: 'http://x/reset#t' }),
    ).toMatchObject({ delivered: false });
    expect(await sendInviteEmail({ to: 'fix7-b@example.test', url: 'http://x/i#t' })).toEqual({
      delivered: false,
    });

    const failing = await emailRow();
    expect(failing.status).toBe('warn');
    expect(failing.detail).toContain('The latest 2 emails through 127.0.0.1 failed');
    expect(failing.detail).toContain('ECONNREFUSED');
    // An instant, which the page shows in the reader's local time, not a
    // string already written in UTC (#345).
    const at = /most recently at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z): /.exec(
      failing.detail,
    );
    expect(at, failing.detail).not.toBeNull();
    expect(Date.parse(at![1]!)).toBeGreaterThanOrEqual(started.getTime() - 1000);
    expect(failing.detail).not.toContain(' UTC');
    expect(failing.detail).toContain('people cannot verify their address or reset');
    // Never a link or token.
    expect(failing.detail).not.toContain('http://x');

    server = await startFakeSmtp(state.smtpPort);
    expect(
      await sendPasswordResetEmail({ to: 'fix7-c@example.test', url: 'http://x/reset#t' }),
    ).toEqual({ delivered: true });
    const recovered = await emailRow();
    expect(recovered.status).toBe('ok');
    expect(recovered.detail).toMatch(
      /^Sending through 127\.0\.0\.1; last delivered \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('counts a failed Send test email, and a working one clears the warning', async () => {
    const { sendTestEmail } = await import('../../services/email.js');
    expect((await sendTestEmail('fix7-admin@example.test')).ok).toBe(false);
    expect((await emailRow()).detail).toContain('The latest email through 127.0.0.1 failed');
    server = await startFakeSmtp(state.smtpPort);
    expect((await sendTestEmail('fix7-admin@example.test')).ok).toBe(true);
    expect((await emailRow()).status).toBe('ok');
  });

  it('tries a failed account email again, once, after the mail server is back', async () => {
    const { sendAfterResponse, setAccountEmailRetryDelays } = await import(
      '../../services/account-email-delivery.js'
    );
    const { sendPasswordResetEmail } = await import('../../services/email.js');
    setAccountEmailRetryDelays([300, 300]);
    const userId = randomUUID();
    const send = (url: string) => () =>
      sendPasswordResetEmail({ to: 'fix7-retry@example.test', url });

    // Two requests during the outage: the newer one replaces the older's retry.
    sendAfterResponse('password-reset', userId, send('http://x/reset#first'));
    await vi.waitFor(async () => expect((await emailRow()).detail).toContain('The latest email'));
    sendAfterResponse('password-reset', userId, send('http://x/reset#second'));
    await vi.waitFor(async () =>
      expect((await emailRow()).detail).toContain('The latest 2 emails'),
    );

    server = await startFakeSmtp(state.smtpPort);
    await vi.waitFor(() => expect(server!.messages).toHaveLength(1), { timeout: 3000 });
    // Long enough for any second retry to have run.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]!.data).toContain('http://x/reset#second');
    expect((await emailRow()).status).toBe('ok');
  });

  it('gives up after the bounded retries', async () => {
    const { sendAfterResponse, setAccountEmailRetryDelays, settleAccountEmails } = await import(
      '../../services/account-email-delivery.js'
    );
    const { sendVerificationEmail } = await import('../../services/email.js');
    setAccountEmailRetryDelays([100, 100]);
    let attempts = 0;
    sendAfterResponse('email-verification', randomUUID(), () => {
      attempts++;
      return sendVerificationEmail({ to: 'fix7-gone@example.test', url: 'http://x/v?t' });
    });
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settleAccountEmails();
    expect(attempts).toBe(3);
  });
});
