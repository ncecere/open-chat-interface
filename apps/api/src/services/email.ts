import nodemailer from 'nodemailer';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { currentAppName } from './branding.js';
import { getSetting } from './settings.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
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

export async function sendVerificationEmail(params: { to: string; url: string }) {
  const appName = await currentAppName();
  return sendEmail({
    to: params.to,
    subject: `Verify your email address for ${appName}`,
    text: `Confirm your email address to finish setting up your ${appName} account:\n\n${params.url}\n\nIf you did not create an account, you can ignore this email.`,
  });
}

export async function sendPasswordResetEmail(params: { to: string; url: string }) {
  const appName = await currentAppName();
  return sendEmail({
    to: params.to,
    subject: `Reset your ${appName} password`,
    text: `Use this link to choose a new password for your ${appName} account:\n\n${params.url}\n\nIf you did not request this, you can ignore this email.`,
  });
}

/** `appName` is read from Branding when not given. */
export async function sendInviteEmail(params: { to: string; url: string; appName?: string }) {
  const appName = params.appName?.trim() || (await currentAppName());
  return sendEmail({
    to: params.to,
    subject: `You have been invited to ${appName}`,
    text: `You have been invited to join ${appName}.\n\nAccept the invitation:\n\n${params.url}`,
  });
}
