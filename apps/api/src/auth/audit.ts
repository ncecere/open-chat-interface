import { recordAudit } from '../services/audit.js';
import { mfaVerifications } from '../services/observability/metrics.js';

/**
 * Authentication events worth recording.
 *
 * Everything else the audit log holds is administrative — who changed a
 * setting, who edited a model. An investigation almost always starts somewhere
 * else: who signed in, from where, and when. Without these the log cannot
 * answer that at all.
 *
 * Only outcomes are recorded, never credentials, tokens, or the body of the
 * request that produced them.
 */
const AUDITED_PATHS = new Map<string, string>([
  ['/sign-in/email', 'auth.signin.local'],
  ['/sign-up/email', 'auth.signup.local'],
  ['/sign-out', 'auth.signout'],
  ['/sign-in/sso', 'auth.signin.sso.start'],
  ['/forget-password', 'auth.password.reset_requested'],
  // The endpoint's current name (Better Auth 1.4+); the line above is the old one.
  ['/request-password-reset', 'auth.password.reset_requested'],
  ['/reset-password', 'auth.password.reset_completed'],
  ['/change-password', 'auth.password.changed'],
  ['/change-email', 'auth.email.change_requested'],
  ['/verify-email', 'auth.email.verified'],
  // Settings "Account" (v0.9.1): a person's own name and devices. The devices
  // list uses /api/me/sessions, which records the same actions; these cover
  // Better Auth's own endpoints when called directly.
  ['/update-user', 'auth.profile.updated'],
  ['/revoke-session', 'auth.session.revoked'],
  ['/revoke-sessions', 'auth.sessions.revoked'],
  ['/revoke-other-sessions', 'auth.sessions.revoked_others'],
  // Two-step verification (v0.14, #399). The code and the passkey are never recorded, only the outcome.
  ['/two-factor/verify-totp', 'auth.mfa.verify'],
  ['/two-factor/verify-backup-code', 'auth.mfa.verify'],
  ['/passkey/verify-authentication', 'auth.passkey.signin'],
  ['/passkey/verify-registration', 'auth.passkey.added'],
  ['/passkey/update-passkey', 'auth.passkey.renamed'],
  ['/passkey/delete-passkey', 'auth.passkey.removed'],
]);

/** The second-step method an audited path verifies, for the metadata and the metric. */
const VERIFY_METHODS = new Map<string, 'totp' | 'recovery_code' | 'passkey'>([
  ['/two-factor/verify-totp', 'totp'],
  ['/two-factor/verify-backup-code', 'recovery_code'],
  ['/passkey/verify-authentication', 'passkey'],
]);

/** Path prefixes whose outcome is a completed SSO sign-in. */
const SSO_CALLBACK_PREFIXES = ['/sso/callback/'];

function actionFor(path: string): string | null {
  const direct = AUDITED_PATHS.get(path);
  if (direct) return direct;

  if (SSO_CALLBACK_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'auth.signin.sso';
  }
  return null;
}

/**
 * A failed attempt is worth more than a successful one.
 *
 * Better Auth answers a bad password with 401 and an unknown account the same
 * way, deliberately, so the log records that an attempt failed rather than
 * guessing why.
 */
function outcomeFor(status: number): 'success' | 'failure' {
  return status >= 200 && status < 400 ? 'success' : 'failure';
}

export interface AuthAuditContext {
  path: string;
  status: number;
  ipAddress: string | null;
  userAgent: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  /**
   * Better Auth's code for a refusal (`BANNED_USER`, `EMAIL_NOT_VERIFIED`,
   * `INVALID_EMAIL_OR_PASSWORD`…), so a refused sign-in says why, not only
   * `status: 403` (#375). It is the code the person was sent already.
   */
  failureCode?: string | null;
  /**
   * The password was right and the person now has to pass a second step: a 200
   * `/sign-in/email` for an account with the second step on (the plugin deletes
   * the session the password made, just after the audit hook runs). Recorded as
   * `auth.signin.local.challenged`, not as a sign-in.
   */
  challenged?: boolean;
  /** The passkey or recovery code a request was about, for rename and remove. */
  targetId?: string | null;
  /** After a recovery code worked: how many remain. */
  recoveryCodesLeft?: number | null;
}

export async function recordAuthEvent(context: AuthAuditContext): Promise<void> {
  const action = actionFor(context.path);
  if (!action) return;

  const outcome = outcomeFor(context.status);
  const method = VERIFY_METHODS.get(context.path);
  if (method) mfaVerifications.inc({ method, outcome });

  if (context.challenged && context.path === '/sign-in/email') {
    await recordAudit({
      actorUserId: null,
      actorEmail: context.actorEmail,
      action: 'auth.signin.local.challenged',
      targetType: 'session',
      targetId: null,
      ipAddress: context.ipAddress,
      metadata: {
        status: context.status,
        ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 300) } : {}),
      },
    });
    return;
  }

  // A sign-in that begins a redirect to an identity provider has not succeeded
  // yet, and recording it as such would double-count against the callback.
  if (action === 'auth.signin.sso.start' && outcome === 'success') return;

  await recordAudit({
    actorUserId: context.actorUserId,
    actorEmail: context.actorEmail,
    action: `${action}.${outcome}`,
    targetType: 'session',
    targetId: context.targetId ?? null,
    ipAddress: context.ipAddress,
    metadata: {
      status: context.status,
      ...(method ? { method } : {}),
      ...(outcome === 'failure' && context.failureCode ? { reason: context.failureCode } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 300) } : {}),
    },
  });
}

/** A recovery code was used up (`auth.mfa.recovery_code.used`): how many are left, never which. */
export async function recordRecoveryCodeUsed(context: {
  actorUserId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  remaining: number | null;
}): Promise<void> {
  await recordAudit({
    actorUserId: context.actorUserId,
    actorEmail: context.actorEmail,
    action: 'auth.mfa.recovery_code.used',
    targetType: 'user',
    targetId: context.actorUserId,
    ipAddress: context.ipAddress,
    metadata: { remaining: context.remaining },
  });
}
