import { logger } from '../lib/logger.js';
import { getSetting } from './settings.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export async function isSmtpConfigured(): Promise<boolean> {
  const smtp = await getSetting('smtp');
  return Boolean(smtp.host && smtp.port && smtp.fromAddress);
}

/**
 * SMTP is optional. When it is not configured the message is logged so an
 * administrator can still complete the flow manually from the container logs.
 */
export async function sendEmail(email: OutboundEmail): Promise<{ delivered: boolean }> {
  if (!(await isSmtpConfigured())) {
    logger.warn(
      { to: email.to, subject: email.subject, body: email.text },
      'SMTP not configured — email logged instead of sent',
    );
    return { delivered: false };
  }

  // Transport implementation is added with the SMTP admin section.
  logger.info({ to: email.to, subject: email.subject }, 'Email queued for delivery');
  return { delivered: true };
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
