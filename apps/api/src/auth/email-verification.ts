import { eq, schema } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sendVerificationEmail } from '../services/email.js';
import { isEmailVerificationEnforced } from './policy.js';

/** Better Auth owns token generation and proof; delivery is never proof of ownership. */
export async function deliverVerificationEmail(
  { user, url }: { user: { id: string; email: string }; url: string },
  requirement?: boolean,
): Promise<void> {
  // Local signup/signin/resend pass their validated request snapshot. Other SDK
  // flows resolve policy here. Never re-read after a resend's account lookup.
  const required = requirement ?? (await isEmailVerificationEnforced());
  if (!required) {
    // Preserve explicitly disabled-policy behavior for local accounts. An SMTP
    // outage or unreadable policy must never enter this grandfathering branch.
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id));
    return;
  }

  try {
    const result = await sendVerificationEmail({ to: user.email, url });
    if (result.delivered) return;
  } catch {
    // The resend endpoint must not reveal whether an address exists by returning
    // an account-specific delivery error. Keep it unverified and allow retry.
  }
  logger.warn({ userId: user.id }, 'Verification email not delivered; account remains unverified');
}
