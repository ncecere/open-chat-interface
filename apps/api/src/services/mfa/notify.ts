import { sendAfterResponse } from '../account-email-delivery.js';
import { currentAppName } from '../branding.js';
import { sendEmail } from '../email.js';

/**
 * Emails about changes to a person's two-step verification (v0.14, #399):
 * somebody who did not make the change learns of it. Sent after the request
 * is answered and never blocking it, when SMTP is set up (without it nothing
 * is sent and nothing fails). A message says what happened and what to do
 * about it, and never a code, a key or a link that signs anyone in.
 */
export type MfaChange =
  | 'enabled'
  | 'disabled'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'passkey_added'
  | 'passkey_removed'
  | 'reset_by_administrator';

const WHAT: Record<MfaChange, (extra: { remaining?: number | null }) => string> = {
  enabled: () => 'Two-step verification with an authenticator app was turned on for your account.',
  disabled: () =>
    'Two-step verification with an authenticator app was turned off for your account.',
  recovery_codes_regenerated: () =>
    'A new set of recovery codes was created for your account. The old codes no longer work.',
  recovery_code_used: ({ remaining }) =>
    `A recovery code was used to sign in to your account.${
      typeof remaining === 'number'
        ? ` You have ${remaining} recovery code${remaining === 1 ? '' : 's'} left.`
        : ''
    }`,
  passkey_added: () => 'A passkey was added to your account.',
  passkey_removed: () => 'A passkey was removed from your account.',
  reset_by_administrator: () =>
    'An administrator reset two-step verification for your account. Your authenticator and passkeys were removed and you were signed out everywhere. You can set it up again in Settings.',
};

const SUBJECT: Record<MfaChange, string> = {
  enabled: 'Two-step verification was turned on',
  disabled: 'Two-step verification was turned off',
  recovery_codes_regenerated: 'New recovery codes were created',
  recovery_code_used: 'A recovery code was used',
  passkey_added: 'A passkey was added',
  passkey_removed: 'A passkey was removed',
  reset_by_administrator: 'Two-step verification was reset by an administrator',
};

export function mfaChangeEmail(
  change: MfaChange,
  appName: string,
  extra: { remaining?: number | null } = {},
): { subject: string; text: string } {
  const what = WHAT[change](extra);
  const advice =
    change === 'reset_by_administrator'
      ? 'If you did not expect this, contact an administrator.'
      : 'If this was not you, change your password now and ask an administrator to reset two-step verification on your account.';
  return {
    subject: `${SUBJECT[change]} on your ${appName} account`,
    text: `${what}\n\n${advice}`,
  };
}

/** Starts the email without waiting; never throws. */
export function notifyMfaChange(
  person: { id: string; email: string },
  change: MfaChange,
  extra: { remaining?: number | null } = {},
): void {
  sendAfterResponse(`mfa-${change}`, person.id, async () => {
    const message = mfaChangeEmail(change, await currentAppName(), extra);
    return sendEmail({ to: person.email, ...message });
  });
}
