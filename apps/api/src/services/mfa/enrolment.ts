import { and, eq, schema } from '@oci/db';
import { APIError } from 'better-auth/api';
import { auth } from '../../auth/index.js';
import { classifyCode } from '../../auth/mfa.js';
import { db } from '../../db/index.js';
import { conflict, validationFailed } from '../../lib/errors.js';
import { currentAppName } from '../branding.js';
import { hasCredentialAccount } from './credential.js';
import {
  assertSecondStepNotLocked,
  clearSecondStepFailures,
  recordSecondStepFailure,
} from './lockout.js';

/**
 * Setting up, confirming, disabling an authenticator and regenerating recovery
 * codes (v0.14, #399): OCI's own routes call the plugin's endpoints server-side
 * (they are answered 404 over HTTP) so the password and the codes are checked in
 * the order and with the limits OCI wants, and the answers carry only what the
 * browser needs. Each function takes the request's headers: the plugin reads
 * the session from them, and the session cookies it sets come back as
 * `setCookies` (confirming and disabling swap the session).
 */
export interface MfaPerson {
  id: string;
  email: string;
}

export interface WithCookies<T> {
  body: T;
  setCookies: string[];
}

export const NOT_AVAILABLE_MESSAGE =
  'Your account signs in through your organisation, so two-step verification is managed there.';
export const WRONG_PASSWORD_MESSAGE = 'Your password is not correct.';
export const WRONG_CODE_MESSAGE =
  'That code is not right. Check the code in your authenticator app and try again.';

function fieldError(field: 'password' | 'code', message: string) {
  return validationFailed(message, [{ path: [field], message }]);
}

function apiCode(error: unknown): string | null {
  return error instanceof APIError && typeof error.body?.code === 'string' ? error.body.code : null;
}

/** An account with a password; anything else is told to use its organisation. */
async function assertCanEnrol(userId: string): Promise<void> {
  if (!(await hasCredentialAccount(userId))) throw conflict(NOT_AVAILABLE_MESSAGE);
}

async function twoFactorRow(userId: string) {
  const [row] = await db
    .select({ verified: schema.twoFactor.verified })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, userId))
    .limit(1);
  return row ?? null;
}

async function passwordMatches(userId: string, password: string): Promise<boolean> {
  const [credential] = await db
    .select({ hash: schema.account.password })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')))
    .limit(1);
  if (!credential?.hash) return false;
  const context = await auth.$context;
  return context.password.verify({ hash: credential.hash, password });
}

/** The base32 secret of an `otpauth://` link, to type by hand. */
export function manualKeyFrom(totpURI: string): string {
  return new URL(totpURI).searchParams.get('secret') ?? '';
}

/**
 * Step one: the password, then a new secret that is not live until a code is
 * confirmed. Refused (409) when an authenticator is already on: replacing one
 * is disabling it and enabling again, because the plugin would activate a
 * replacement unconfirmed.
 */
export async function beginTotp(
  person: MfaPerson,
  headers: Headers,
  password: string,
): Promise<{ totpURI: string; manualKey: string }> {
  await assertCanEnrol(person.id);
  const existing = await twoFactorRow(person.id);
  if (existing?.verified) {
    throw conflict(
      'An authenticator is already set up. Turn it off first if you want to set up a new one.',
    );
  }
  if (!(await passwordMatches(person.id, password))) {
    throw fieldError('password', WRONG_PASSWORD_MESSAGE);
  }
  const enabled = await auth.api.enableTwoFactor({
    headers,
    body: { password, issuer: await currentAppName() },
  });
  // The plugin also returns recovery codes here; they are shown at confirmation, not now.
  return { totpURI: enabled.totpURI, manualKey: manualKeyFrom(enabled.totpURI) };
}

/**
 * Step two: the first code. The plugin turns the second step on and replaces
 * the session (`Set-Cookie`); the recovery codes made in step one are read once
 * here and returned once. A wrong code leaves the secret in place to try again.
 */
export async function confirmTotp(
  person: MfaPerson,
  headers: Headers,
  code: string,
): Promise<WithCookies<{ recoveryCodes: string[] }>> {
  await assertCanEnrol(person.id);
  const row = await twoFactorRow(person.id);
  if (!row || row.verified) {
    throw conflict('There is nothing to confirm. Start again from "Set up an authenticator".');
  }
  let setCookies: string[];
  try {
    const verified = await auth.api.verifyTOTP({ headers, body: { code }, returnHeaders: true });
    setCookies = verified.headers.getSetCookie();
  } catch (error) {
    const reason = apiCode(error);
    if (reason === 'INVALID_CODE') throw fieldError('code', WRONG_CODE_MESSAGE);
    if (reason === 'CODE_ALREADY_USED') throw fieldError('code', (error as APIError).message);
    throw error;
  }
  const { backupCodes } = await auth.api.viewBackupCodes({ body: { userId: person.id } });
  return { body: { recoveryCodes: backupCodes }, setCookies };
}

/**
 * Checks a current code, an authenticator code or a recovery code, for the
 * operations that need one. A wrong code counts toward the lockout and a right
 * one clears it; a locked second step refuses first.
 */
async function verifyCurrentCode(person: MfaPerson, headers: Headers, code: string): Promise<void> {
  await assertSecondStepNotLocked(person.id);
  try {
    if (classifyCode(code) === 'totp') {
      await auth.api.verifyTOTP({ headers, body: { code } });
    } else {
      await auth.api.verifyBackupCode({ headers, body: { code, disableSession: true } });
    }
  } catch (error) {
    const reason = apiCode(error);
    if (reason === 'CODE_ALREADY_USED') throw fieldError('code', (error as APIError).message);
    if (reason === 'INVALID_CODE' || reason === 'INVALID_BACKUP_CODE') {
      await recordSecondStepFailure(person.id);
      throw fieldError('code', WRONG_CODE_MESSAGE);
    }
    throw error;
  }
  await clearSecondStepFailures(person.id);
}

async function assertEnrolled(userId: string): Promise<void> {
  const row = await twoFactorRow(userId);
  if (!row?.verified) throw conflict('Two-step verification with an authenticator is not on.');
}

/** Turning the authenticator off takes the password and a current code, so a stolen session is not enough. */
export async function disableTotp(
  person: MfaPerson,
  headers: Headers,
  input: { password: string; code: string },
): Promise<WithCookies<{ ok: true }>> {
  await assertEnrolled(person.id);
  if (!(await passwordMatches(person.id, input.password))) {
    throw fieldError('password', WRONG_PASSWORD_MESSAGE);
  }
  await verifyCurrentCode(person, headers, input.code);
  const disabled = await auth.api.disableTwoFactor({
    headers,
    body: { password: input.password },
    returnHeaders: true,
  });
  return { body: { ok: true }, setCookies: disabled.headers.getSetCookie() };
}

/** New recovery codes: the password and a current code; the old codes stop working. */
export async function regenerateRecoveryCodes(
  person: MfaPerson,
  headers: Headers,
  input: { password: string; code: string },
): Promise<{ recoveryCodes: string[] }> {
  await assertEnrolled(person.id);
  if (!(await passwordMatches(person.id, input.password))) {
    throw fieldError('password', WRONG_PASSWORD_MESSAGE);
  }
  await verifyCurrentCode(person, headers, input.code);
  const generated = await auth.api.generateBackupCodes({
    headers,
    body: { password: input.password },
  });
  return { recoveryCodes: generated.backupCodes };
}
