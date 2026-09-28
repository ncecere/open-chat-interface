import nodemailer from 'nodemailer';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
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
      from: smtp.fromAddress,
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

export async function sendVerificationEmail(params: { to: string; url: string }) {
  return sendEmail({
    to: params.to,
    subject: 'Verify your email address',
    text: `Confirm your email address to finish setting up your account:\n\n${params.url}`,
  });
}

export async function sendPasswordResetEmail(params: { to: string; url: string }) {
  return sendEmail({
    to: params.to,
    subject: 'Reset your password',
    text: `Use this link to choose a new password:\n\n${params.url}\n\nIf you did not request this, you can ignore this email.`,
  });
}

export async function sendInviteEmail(params: { to: string; url: string; appName: string }) {
  return sendEmail({
    to: params.to,
    subject: `You have been invited to ${params.appName}`,
    text: `You have been invited to join ${params.appName}.\n\nAccept the invitation:\n\n${params.url}`,
  });
}
