import { eq, schema } from '@oci/db';
import { db } from '../db/index.js';
import {
  ACCOUNT_EMAIL_COOLDOWN_SECONDS,
  sendAfterResponse,
} from '../services/account-email-delivery.js';
import { sendVerificationEmail, VERIFY_LINK_TTL_SECONDS } from '../services/email.js';
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

  // After answering (#328): resend verification's 500 ms floor hid a fast
  // mail server, not a slow or unreachable one. A failure is never returned:
  // the resend endpoint must not reveal whether an address exists through an
  // account-specific delivery error. The account stays unverified and can ask
  // again. Not again within a minute of one delivered (#330): accepting an
  // invitation, a refused sign-in and Resend each sent one, seconds apart.
  sendAfterResponse(
    'email-verification',
    user.id,
    () =>
      sendVerificationEmail({
        to: user.email,
        url,
        expiresInSeconds: VERIFY_LINK_TTL_SECONDS,
      }),
    { cooldownSeconds: ACCOUNT_EMAIL_COOLDOWN_SECONDS },
  );
}
