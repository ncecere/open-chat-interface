import { z } from 'zod';
import { USER_ROLES } from '../constants.js';

/**
 * Two-step verification for local accounts (v0.14, #399; docs/dev/mfa-api.md
 * lists every endpoint these shapes belong to).
 */

/**
 * How a session was created, recorded in `session.auth_method`. The
 * requirement for a role (below) tells a password-only session from one that
 * passed a second step, a passkey or single sign-on by this. A session that
 * predates the column (NULL) reads as `password`.
 */
export const SESSION_AUTH_METHODS = [
  'password',
  'totp',
  'recovery_code',
  'passkey',
  'sso',
  'other',
] as const;
export type SessionAuthMethod = (typeof SESSION_AUTH_METHODS)[number];

/** The second steps a person can have set up. */
export const MFA_METHODS = ['totp', 'passkey'] as const;
export type MfaMethod = (typeof MFA_METHODS)[number];

/** Days after a role is required (or an account is created) before people are limited. */
export const MFA_DEFAULT_GRACE_DAYS = 14;
export const MFA_MAX_GRACE_DAYS = 365;

/** Where a limited person is sent to set up (a web route, outside the app shell). */
export const MFA_SETUP_PATH = '/auth/mfa-setup';

/** The second-step page of the sign-in flow (a public web route). */
export const MFA_CHALLENGE_PATH = '/auth/two-factor';

/** The requirement as stored (the `auth` instance setting) and as the administrator reads it. */
export const mfaRequirementSchema = z.object({
  /** Roles whose local accounts must have a second step. Empty means nobody. */
  roles: z.array(z.enum(USER_ROLES)),
  /** 0 limits people at their next request; the default is 14. */
  graceDays: z.number().int().min(0).max(MFA_MAX_GRACE_DAYS),
  /**
   * When each role was added to the requirement (ISO time), stamped by the
   * server. A person's deadline is the later of this and their account's
   * creation, plus the grace days.
   */
  since: z.partialRecord(z.enum(USER_ROLES), z.string()),
});

/** What an administrator sends: the roles and the grace; `since` is never written by a client. */
export const mfaRequirementInputSchema = z
  .object({
    roles: z.array(z.enum(USER_ROLES)).max(USER_ROLES.length),
    graceDays: z.number().int().min(0).max(MFA_MAX_GRACE_DAYS),
  })
  .strict();

/** One person's second-step state, for the shell and the settings page (GET /api/me, `mfa`). */
export const mfaSummarySchema = z.object({
  /**
   * They can sign in with a password (a `credential` account). False for an
   * account that signs in only through the organisation: it cannot enrol,
   * is never required to, and the page says "Managed by your organisation".
   */
  eligible: z.boolean(),
  /** An authenticator is confirmed, or at least one passkey is registered. */
  enrolled: z.boolean(),
  methods: z.array(z.enum(MFA_METHODS)),
  /** Recovery codes not yet used; null without an authenticator. Never the codes. */
  recoveryCodesLeft: z.number().int().nonnegative().nullable(),
  /** Their role is on the requirement list and they can sign in with a password. */
  required: z.boolean(),
  /** ISO time after which a required person who is not satisfied is limited; null when not required. */
  deadline: z.string().nullable(),
  /**
   * This session is being refused (403 MFA_ENROLMENT_REQUIRED) everywhere but
   * the allowlist: the web app shows the setup page.
   */
  limited: z.boolean(),
});

/** A registered passkey as the person sees it; never the public key or the counter. */
export const passkeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().nullable(),
  deviceType: z.string(),
  backedUp: z.boolean(),
});

/** GET /api/me/mfa. */
export const mfaStatusSchema = mfaSummarySchema.extend({
  passkeys: z.array(passkeySummarySchema),
  /** ISO time until which the second step is locked after too many wrong codes; null when not. */
  lockedUntil: z.string().nullable(),
});

const passwordField = z.string().min(1).max(200);
/** A TOTP code or a recovery code, as typed; the server removes spaces and adds a missing hyphen. */
const codeField = z.string().trim().min(1).max(64);

/** POST /api/me/mfa/totp. */
export const enableTotpInputSchema = z.object({ password: passwordField }).strict();
export const enableTotpResponseSchema = z.object({
  /** The `otpauth://` link, for the QR code and for phones. Shown once, never stored in the browser. */
  totpURI: z.string(),
  /** The secret from the link as a base32 key to type by hand (the accessible alternative to the QR code). */
  manualKey: z.string(),
});

/** POST /api/me/mfa/totp/confirm. */
export const confirmTotpInputSchema = z.object({ code: codeField }).strict();
/** Shown once; hold them in component state only. */
export const recoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });

/** POST /api/me/mfa/totp/disable and POST /api/me/mfa/recovery-codes: the password and a current code. */
export const mfaReauthInputSchema = z.object({ password: passwordField, code: codeField }).strict();

/** What an administrator sees of a person's second step (GET /api/admin/users/:id, `mfa`). */
export const adminMfaStatusSchema = z.object({
  eligible: z.boolean(),
  totp: z.boolean(),
  passkeys: z.number().int().nonnegative(),
  recoveryCodesLeft: z.number().int().nonnegative().nullable(),
  lockedUntil: z.string().nullable(),
  required: z.boolean(),
  deadline: z.string().nullable(),
});

/** POST /api/admin/users/:id/mfa/reset. */
export const adminMfaResetResponseSchema = z.object({
  ok: z.literal(true),
  sessionsEnded: z.number().int().nonnegative(),
});

/** One role's row in GET /api/admin/settings/mfa-impact: who the requirement would limit. */
export const mfaImpactRoleSchema = z.object({
  role: z.enum(USER_ROLES),
  /** Active, unbanned accounts in the role. */
  people: z.number().int().nonnegative(),
  /** Of those, accounts with no password (single sign-on only): never limited. */
  exempt: z.number().int().nonnegative(),
  /** With a password and a second step set up. */
  enrolled: z.number().int().nonnegative(),
  /** With a password and no second step: the people who would be limited after the grace. */
  unenrolled: z.number().int().nonnegative(),
  /** The role is on the requirement now. */
  required: z.boolean(),
  /** ISO time the role was added; null when it is not required. */
  since: z.string().nullable(),
  /** ISO time the earliest unenrolled account in the role is limited; null with none or not required. */
  firstDeadline: z.string().nullable(),
});
export const mfaImpactSchema = z.object({
  graceDays: z.number().int(),
  roles: z.array(mfaImpactRoleSchema),
});

export type MfaRequirement = z.infer<typeof mfaRequirementSchema>;
export type MfaRequirementInput = z.infer<typeof mfaRequirementInputSchema>;
export type MfaSummary = z.infer<typeof mfaSummarySchema>;
export type MfaStatus = z.infer<typeof mfaStatusSchema>;
export type PasskeySummary = z.infer<typeof passkeySummarySchema>;
export type EnableTotpInput = z.infer<typeof enableTotpInputSchema>;
export type EnableTotpResponse = z.infer<typeof enableTotpResponseSchema>;
export type ConfirmTotpInput = z.infer<typeof confirmTotpInputSchema>;
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;
export type MfaReauthInput = z.infer<typeof mfaReauthInputSchema>;
export type AdminMfaStatus = z.infer<typeof adminMfaStatusSchema>;
export type AdminMfaResetResponse = z.infer<typeof adminMfaResetResponseSchema>;
export type MfaImpact = z.infer<typeof mfaImpactSchema>;
export type MfaImpactRole = z.infer<typeof mfaImpactRoleSchema>;

/**
 * Why a limited session is refused (`details.reason` of MFA_ENROLMENT_REQUIRED):
 * `enrol` — no second step yet, set one up; `second_step` — one is set up but
 * this session was opened with the password alone, so sign in again with it.
 */
export const MFA_LIMIT_REASONS = ['enrol', 'second_step'] as const;
export type MfaLimitReason = (typeof MFA_LIMIT_REASONS)[number];
