import nodemailer from 'nodemailer';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { currentAppName } from './branding.js';
import { getSetting } from './settings.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** An HTML alternative to `text`; mail clients show whichever they prefer. */
  html?: string;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/**
 * A plain HTML alternative for the account emails (#78): the same words as
 * the text part, with the link as a button. Inline styles only, which is all
 * mail clients reliably honour; every value is escaped.
 */
export function actionEmailHtml(email: {
  paragraphs: string[];
  action: { label: string; url: string };
  footer?: string;
}): string {
  const p = (text: string, style = 'margin:0 0 16px') =>
    `<p style="${style}">${escapeHtml(text)}</p>`;
  return [
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">',
    '<div style="max-width:520px;margin:0 auto">',
    ...email.paragraphs.map((text) => p(text)),
    `<p style="margin:24px 0"><a href="${escapeHtml(email.action.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1a1a1a;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(email.action.label)}</a></p>`,
    p(
      `Or open this link: ${email.action.url}`,
      'margin:0 0 16px;font-size:13px;color:#555;word-break:break-all',
    ),
    ...(email.footer ? [p(email.footer, 'margin:24px 0 0;font-size:13px;color:#555')] : []),
    '</div></body></html>',
  ].join('');
}

/**
 * Whether SMTP is sufficiently configured for an auth flow to depend on it.
 * This deliberately does not make a network connection on every sign-in, but
 * it does verify that any stored credential can be decrypted. Delivery errors
 * do not change whether verification is required; callers keep accounts
 * unverified and offer another delivery attempt.
 */
export async function isSmtpUsable(): Promise<boolean> {
  try {
    const smtp = await getSetting('smtp');
    if (!smtp.host || !smtp.port || !smtp.fromAddress) return false;
    if (smtp.encryptedPassword) decryptSecret(smtp.encryptedPassword);
    return true;
  } catch (error) {
    logger.warn({ error }, 'SMTP configuration is unusable');
    return false;
  }
}

/** A bare address, without a display name of its own. */
const BARE_ADDRESS = /^[^\s<>"@]+@[^\s<>"@]+$/;

/**
 * The From header. A bare configured address gets the instance name as its
 * display name ("Acme AI" <no-reply@acme.test>); an address the administrator
 * already gave a name (`Help Desk <help@acme.test>`) is left as it is.
 */
export function fromHeader(
  fromAddress: string,
  appName: string,
): string | { name: string; address: string } {
  const address = fromAddress.trim();
  return BARE_ADDRESS.test(address) ? { name: appName, address } : address;
}

/**
 * SMTP is optional. Missing configuration or failed delivery returns false;
 * logs include delivery metadata, never message bodies or verification tokens.
 */
export async function sendEmail(email: OutboundEmail): Promise<{ delivered: boolean }> {
  const smtp = await getSetting('smtp');
  if (!smtp.host || !smtp.port || !smtp.fromAddress) {
    // URLs can contain invite/reset tokens, so never log the message body.
    logger.warn({ to: email.to, subject: email.subject }, 'SMTP not configured — email not sent');
    return { delivered: false };
  }

  try {
    const password = smtp.encryptedPassword ? decryptSecret(smtp.encryptedPassword) : null;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.username
        ? {
            auth: {
              user: smtp.username,
              pass: password ?? '',
            },
          }
        : {}),
    });

    await transport.sendMail({
      from: fromHeader(smtp.fromAddress, await currentAppName()),
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    });
    logger.info({ to: email.to, subject: email.subject }, 'Email delivered');
    return { delivered: true };
  } catch (error) {
    logger.error({ error, to: email.to, subject: email.subject }, 'Email delivery failed');
    return { delivered: false };
  }
}

/**
 * Sends one message to `to` with the saved settings and reports why it
 * failed, for the Email delivery page's Send test email (#115). sendEmail
 * deliberately says only whether it worked; an administrator testing needs
 * the server's reason ("Invalid login: 535 …", "connect ECONNREFUSED …").
 */
export async function sendTestEmail(to: string): Promise<{ ok: boolean; message: string }> {
  const smtp = await getSetting('smtp');
  if (!smtp.host || !smtp.port || !smtp.fromAddress) {
    return {
      ok: false,
      message: 'Email delivery is not set up: save a host, port and From address first.',
    };
  }
  const appName = await currentAppName();
  try {
    const password = smtp.encryptedPassword ? decryptSecret(smtp.encryptedPassword) : null;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      ...(smtp.username ? { auth: { user: smtp.username, pass: password ?? '' } } : {}),
    });
    await transport.sendMail({
      from: fromHeader(smtp.fromAddress, appName),
      to,
      subject: `Test email from ${appName}`,
      text: `This is a test message from ${appName}'s Email delivery settings. If you can read it, email delivery works.`,
    });
    logger.info({ to }, 'Test email delivered');
    return { ok: true, message: `Sent to ${to}. Check that it arrived.` };
  } catch (error) {
    logger.warn({ error, to }, 'Test email failed');
    const reason = error instanceof Error ? error.message.slice(0, 300) : 'Unknown error';
    return { ok: false, message: `The mail server refused or could not be reached: ${reason}` };
  }
}

// Each message names the instance (Branding > App name) in its subject and
// body, so a person with accounts on several instances can tell them apart.

/** How long an email verification link works (Better Auth's emailVerification.expiresIn). */
export const VERIFY_LINK_TTL_SECONDS = 60 * 60;

/**
 * The verification link and how long it works (#236), as the reset email
 * says since #184: opened later, the link only failed.
 */
export async function sendVerificationEmail(params: {
  to: string;
  url: string;
  expiresInSeconds?: number;
}) {
  const appName = await currentAppName();
  const intro = `Confirm your email address to finish setting up your ${appName} account:`;
  const lifetime = duration(params.expiresInSeconds ?? VERIFY_LINK_TTL_SECONDS);
  const expiry = `This link works for ${lifetime}. After that, sign in and choose “Resend verification email” for a new one.`;
  const ignore = 'If you did not create an account, you can ignore this email.';
  return sendEmail({
    to: params.to,
    subject: `Verify your email address for ${appName}`,
    text: `${intro}\n\n${params.url}\n\n${expiry}\n\n${ignore}`,
    html: actionEmailHtml({
      paragraphs: [intro],
      action: { label: 'Verify email address', url: params.url },
      footer: `${expiry} ${ignore}`,
    }),
  });
}

/** How long a password reset link works (Better Auth's resetPasswordTokenExpiresIn). */
export const RESET_LINK_TTL_SECONDS = 60 * 60;

/** "1 hour", "2 hours", "30 minutes". */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The reset link and how long it works (#184): opened later it only said
 * "This reset link is invalid or has expired", with no warning in the email.
 */
export async function sendPasswordResetEmail(params: {
  to: string;
  url: string;
  expiresInSeconds?: number;
}) {
  const appName = await currentAppName();
  const intro = `Use this link to choose a new password for your ${appName} account:`;
  const lifetime = duration(params.expiresInSeconds ?? RESET_LINK_TTL_SECONDS);
  const expiry = `This link works for ${lifetime}. After that, ask for a new one with “Forgot your password?” on the sign-in page.`;
  const ignore = 'If you did not request this, you can ignore this email.';
  const footer = `${expiry} ${ignore}`;
  return sendEmail({
    to: params.to,
    subject: `Reset your ${appName} password`,
    text: `${intro}\n\n${params.url}\n\n${expiry}\n\n${ignore}`,
    html: actionEmailHtml({
      paragraphs: [intro],
      action: { label: 'Choose a new password', url: params.url },
      footer,
    }),
  });
}

const ROLE_NAMES: Record<string, string> = {
  admin: 'an administrator',
  auditor: 'an auditor',
  user: 'a user',
  restricted: 'a restricted user',
};

/**
 * The invitation (#78): who sent it, the role it grants and when it expires,
 * which the email left out. `appName` is read from Branding when not given.
 */
export async function sendInviteEmail(params: {
  to: string;
  url: string;
  appName?: string;
  inviter?: string;
  role?: string;
  expiresAt?: Date | null;
}) {
  const appName = params.appName?.trim() || (await currentAppName());
  const who = params.inviter?.trim()
    ? `${params.inviter.trim()} has invited you`
    : 'You have been invited';
  const role = params.role && ROLE_NAMES[params.role] ? ` as ${ROLE_NAMES[params.role]}` : '';
  const intro = `${who} to join ${appName}${role}.`;
  const expiry =
    params.expiresAt === undefined
      ? null
      : params.expiresAt === null
        ? 'The invitation does not expire.'
        : `The invitation expires on ${params.expiresAt.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          })} (UTC).`;
  return sendEmail({
    to: params.to,
    subject: `You have been invited to ${appName}`,
    text: [
      intro,
      '',
      'Accept the invitation:',
      '',
      params.url,
      ...(expiry ? ['', expiry] : []),
    ].join('\n'),
    html: actionEmailHtml({
      paragraphs: [intro],
      action: { label: 'Accept the invitation', url: params.url },
      ...(expiry ? { footer: expiry } : {}),
    }),
  });
}
