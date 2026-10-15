import type { MfaLimitReason, MfaRequirement, SessionAuthMethod, UserRole } from '@oci/shared';

/**
 * The rules of two-step verification that need no database (v0.14, #399;
 * SPEC-mfa.md): how a session's method is told from the endpoint that made it,
 * what people type, which sessions satisfy a role's requirement, and when a
 * person is limited. The gate (middleware/mfa-gate.ts), `GET /api/me` and the
 * administrators' impact figures all use `evaluateMfa`, so they cannot disagree.
 */

/**
 * The second step's account lockout, as the plugin applies it at sign-in and
 * as OCI applies it to disabling and regenerating (the plugin counts nothing
 * for a signed-in person): this many consecutive failures lock it for this many
 * seconds, across challenges and factors.
 */
export const MFA_LOCKOUT_ATTEMPTS = 10;
export const MFA_LOCKOUT_SECONDS = 15 * 60;

/**
 * How a session was created, from the Better Auth endpoint that created it
 * (`context.path` in `session.create.before`; settled by
 * mfa-library-behaviour.unit.test.ts: it is set for sessions made inside
 * `auth.api.*` calls too). Null when no endpoint made it, which is stored as
 * NULL and read as a password session.
 */
export function authMethodFor(path: string | null | undefined): SessionAuthMethod | null {
  if (!path) return null;
  if (path === '/sign-in/email' || path === '/sign-up/email') return 'password';
  if (path === '/two-factor/verify-totp') return 'totp';
  if (path === '/two-factor/verify-backup-code') return 'recovery_code';
  if (path === '/passkey/verify-authentication') return 'passkey';
  // The shared callback and the per-provider one.
  if (path === '/sso/callback' || path.startsWith('/sso/callback/')) return 'sso';
  // An email link (verification signs the person in once), disabling the second
  // step, anything added later: a session that proves nothing about a second step.
  return 'other';
}

/** An authenticator code as typed: `123 456` and pasted white space are fine, nothing else is changed. */
export function normaliseTotpCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * A recovery code as typed. They are case-sensitive, so only the white space
 * around them is trimmed, and the hyphen is added to ten pasted characters
 * (`xxxxx-xxxxx` is how they are shown).
 */
export function normaliseRecoveryCode(raw: string): string {
  const trimmed = raw.trim();
  return /^[A-Za-z0-9]{10}$/.test(trimmed) ? `${trimmed.slice(0, 5)}-${trimmed.slice(5)}` : trimmed;
}

/** Whether what was typed is an authenticator code (six digits) or, otherwise, taken for a recovery code. */
export function classifyCode(raw: string): 'totp' | 'recovery_code' {
  return /^\d{6}$/.test(normaliseTotpCode(raw)) ? 'totp' : 'recovery_code';
}

/**
 * Whether a session has passed what the requirement asks. Single sign-on and
 * passkey sessions always have (the identity provider enforces its own, and a
 * passkey with user verification is both factors); a session opened with a
 * code counts only while the second step is still on, so switching it off ends
 * the credit. A password session, an `other` one and one with no method do not.
 */
export function isSatisfiedSession(
  authMethod: string | null | undefined,
  twoFactorEnabled: boolean,
): boolean {
  if (authMethod === 'sso' || authMethod === 'passkey') return true;
  return (authMethod === 'totp' || authMethod === 'recovery_code') && twoFactorEnabled;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a person's role starts to limit them: the later of when the role was
 * added to the requirement and when their account was made, plus the grace
 * days. A new account gets the grace too. A role with no stamp (settings edited
 * by hand) counts from the account's creation alone. Null when the role is not
 * required.
 */
export function mfaDeadline(
  requirement: MfaRequirement,
  role: UserRole,
  accountCreatedAt: Date,
): Date | null {
  if (!requirement.roles.includes(role)) return null;
  const stamped = Date.parse(requirement.since[role] ?? '');
  const start = Number.isNaN(stamped)
    ? accountCreatedAt.getTime()
    : Math.max(stamped, accountCreatedAt.getTime());
  return new Date(start + requirement.graceDays * DAY_MS);
}

export interface MfaEvaluation {
  /** The role is on the requirement list. */
  required: boolean;
  deadline: Date | null;
  satisfied: boolean;
  pastDeadline: boolean;
  /**
   * Limited unless the person cannot sign in with a password at all: the gate
   * and `/api/me` look that up (one query) only when this is true.
   */
  candidate: boolean;
  reason: MfaLimitReason | null;
}

export function evaluateMfa(input: {
  role: UserRole;
  authMethod: string | null | undefined;
  twoFactorEnabled: boolean;
  accountCreatedAt: Date;
  requirement: MfaRequirement;
  now: Date;
}): MfaEvaluation {
  const deadline = mfaDeadline(input.requirement, input.role, input.accountCreatedAt);
  const required = deadline !== null;
  const satisfied = isSatisfiedSession(input.authMethod, input.twoFactorEnabled);
  const pastDeadline = deadline !== null && deadline.getTime() <= input.now.getTime();
  const candidate = required && !satisfied && pastDeadline;
  return {
    required,
    deadline,
    satisfied,
    pastDeadline,
    candidate,
    reason: candidate ? (input.twoFactorEnabled ? 'second_step' : 'enrol') : null,
  };
}
