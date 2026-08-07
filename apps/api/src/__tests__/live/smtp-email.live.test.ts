import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmtpSettings } from '../../services/settings.js';

/**
 * Exercises the real email service against a real SMTP server (Mailpit) so the
 * assertions cover what is actually put on the wire: envelope, subject, and —
 * most importantly — that invite links keep their token in the URL fragment.
 * A mocked nodemailer can only prove that we called it, not what was delivered.
 *
 * Start the server with:
 *   docker compose -f docker/compose.auth-test.yaml up -d mailpit
 */
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025';
/** CI reaches Mailpit by service alias; locally it is published on localhost. */
const MAILPIT_SMTP_HOST = process.env.SMTP_TEST_HOST ?? '127.0.0.1';
const MAILPIT_SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);

/** Only the SMTP settings are stubbed; nodemailer stays real. */
const stub = vi.hoisted(() => ({
  smtp: {
    host: null,
    port: null,
    secure: false,
    fromAddress: null,
    username: null,
    encryptedPassword: null,
  } as SmtpSettings,
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => (key === 'smtp' ? stub.smtp : {}),
}));

/**
 * The service must never log message bodies, since invite and reset URLs carry
 * bearer tokens. Capturing the logger is the only way to assert that.
 */
const log = vi.hoisted(() => ({
  entries: [] as { level: string; payload: unknown; message: unknown }[],
}));

vi.mock('../../lib/logger.js', () => {
  const record = (level: string) => (payload: unknown, message?: unknown) => {
    log.entries.push({ level, payload, message });
  };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
});

const { isSmtpUsable, sendInviteEmail, sendPasswordResetEmail, sendVerificationEmail } =
  await import('../../services/email.js');

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string };
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILPIT_API}/api/v1/messages?limit=1`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await mailpitReachable();

async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT_API}/api/v1/messages`, { method: 'DELETE' });
}

/** Mailpit accepts the message before it is queryable, so poll briefly. */
async function waitForMessage(recipient: string): Promise<MailpitSummary> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
    );
    const body = (await response.json()) as { messages?: MailpitSummary[] };
    const message = body.messages?.[0];
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No message delivered to ${recipient}`);
}

async function messageText(id: string): Promise<string> {
  const response = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  const body = (await response.json()) as { Text: string };
  return body.Text;
}

describe.skipIf(!available)('live SMTP: outbound email', () => {
  beforeEach(async () => {
    log.entries.length = 0;
    stub.smtp = {
      host: MAILPIT_SMTP_HOST,
      port: MAILPIT_SMTP_PORT,
      secure: false,
      fromAddress: 'no-reply@oci.test',
      username: null,
      encryptedPassword: null,
    };
    await clearMailbox();
  });

  afterEach(async () => {
    await clearMailbox();
  });

  it('delivers an invite carrying the token in the URL fragment, not the query', async () => {
    const to = 'invitee@example.com';
    const token = 'invite-token-abc123';
    const url = `http://localhost:3000/auth/accept-invite#token=${token}`;

    const result = await sendInviteEmail({ to, url, appName: 'Open Chat Interface' });
    expect(result.delivered).toBe(true);

    const message = await waitForMessage(to);
    expect(message.Subject).toBe('You have been invited to Open Chat Interface');
    expect(message.From.Address).toBe('no-reply@oci.test');

    const text = await messageText(message.ID);
    expect(text).toContain(`/auth/accept-invite#token=${token}`);
    // A query-string token would leak into proxy and access logs.
    expect(text).not.toContain('?token=');
    expect(text).not.toContain('&token=');
  });

  it('delivers a password reset email', async () => {
    const to = 'reset@example.com';
    const url = 'http://localhost:3000/auth/reset-password#token=reset-token-xyz';

    const result = await sendPasswordResetEmail({ to, url });
    expect(result.delivered).toBe(true);

    const message = await waitForMessage(to);
    expect(message.Subject).toBe('Reset your password');
    expect(await messageText(message.ID)).toContain(url);
  });

  it('delivers a verification email', async () => {
    const to = 'verify@example.com';
    const url = 'http://localhost:3000/auth/verify?token=verify-token';

    const result = await sendVerificationEmail({ to, url });
    expect(result.delivered).toBe(true);

    const message = await waitForMessage(to);
    expect(message.Subject).toBe('Verify your email address');
    expect(await messageText(message.ID)).toContain(url);
  });

  it('reports SMTP unusable when it is not configured', async () => {
    stub.smtp = { ...stub.smtp, host: null, port: null, fromAddress: null };
    expect(await isSmtpUsable()).toBe(false);

    stub.smtp = { ...stub.smtp, host: MAILPIT_SMTP_HOST, port: MAILPIT_SMTP_PORT };
    // Still missing a from address, so auth flows must not depend on it.
    expect(await isSmtpUsable()).toBe(false);
  });

  it('reports SMTP usable when fully configured against the live server', async () => {
    expect(await isSmtpUsable()).toBe(true);
  });

  it('fails gracefully without logging the message body when delivery fails', async () => {
    // Port 1 is closed, so the transport gets a connection refusal.
    stub.smtp = { ...stub.smtp, port: 1 };
    const url = 'http://localhost:3000/auth/reset-password#token=super-secret-token';

    const result = await sendPasswordResetEmail({ to: 'nobody@example.com', url });
    expect(result.delivered).toBe(false);

    const failure = log.entries.find((entry) => entry.level === 'error');
    expect(failure).toBeDefined();

    const serialized = JSON.stringify(log.entries);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('choose a new password');
    // The non-sensitive envelope is still logged so failures are diagnosable.
    expect(serialized).toContain('nobody@example.com');
  }, 20_000);
});
