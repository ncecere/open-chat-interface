import { getAuthenticatorName } from '@better-auth/passkey';
import { eq, schema } from '@oci/db';
import type { MfaMethod, MfaStatus, MfaSummary, PasskeySummary, UserRole } from '@oci/shared';
import { auth } from '../../auth/index.js';
import { evaluateMfa } from '../../auth/mfa.js';
import { countRecoveryCodes } from '../../auth/recovery-codes.js';
import { db } from '../../db/index.js';
import { isConnectionError } from '../../lib/db-connection.js';
import { logger } from '../../lib/logger.js';
import type { SessionMfaFacts } from '../../middleware/context.js';
import { getSetting, normalizeMfaRequirement } from '../settings.js';
import { hasCredentialAccount } from './credential.js';

/**
 * What one person has set up, from the database (v0.14, #399). The summary and
 * the status are built from this plus the session's facts and the requirement;
 * the gate (middleware/mfa-gate.ts) asks only `hasCredentialAccount`.
 */
export interface MfaPersonState {
  /** An account with a password: the only kind that can set up a second step. */
  credential: boolean;
  /** An authenticator row, whether or not it was confirmed. */
  totp: { confirmed: boolean; lockedUntil: Date | null; backupCodes: string } | null;
  passkeys: PasskeySummary[];
}

/** The name the person gave it, else the authenticator's, else "Passkey". */
export function passkeyLabel(name: string | null, aaguid: string | null): string {
  return name?.trim() || getAuthenticatorName(aaguid) || 'Passkey';
}

export async function loadMfaPersonState(userId: string): Promise<MfaPersonState> {
  const [credential, rows, passkeys] = await Promise.all([
    hasCredentialAccount(userId),
    db
      .select({
        verified: schema.twoFactor.verified,
        lockedUntil: schema.twoFactor.lockedUntil,
        backupCodes: schema.twoFactor.backupCodes,
      })
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, userId))
      .limit(1),
    db
      .select({
        id: schema.passkey.id,
        name: schema.passkey.name,
        createdAt: schema.passkey.createdAt,
        deviceType: schema.passkey.deviceType,
        backedUp: schema.passkey.backedUp,
        aaguid: schema.passkey.aaguid,
      })
      .from(schema.passkey)
      .where(eq(schema.passkey.userId, userId))
      .orderBy(schema.passkey.createdAt),
  ]);
  const [row] = rows;
  return {
    credential,
    totp: row
      ? { confirmed: row.verified, lockedUntil: row.lockedUntil, backupCodes: row.backupCodes }
      : null,
    passkeys: passkeys.map((passkey) => ({
      id: passkey.id,
      name: passkeyLabel(passkey.name, passkey.aaguid),
      createdAt: passkey.createdAt?.toISOString() ?? null,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    })),
  };
}

/** Recovery codes left for a confirmed authenticator; never the codes. */
export async function recoveryCodesLeft(state: MfaPersonState): Promise<number | null> {
  if (!state.totp?.confirmed) return null;
  return countRecoveryCodes((await auth.$context).secretConfig, state.totp.backupCodes);
}

/**
 * The requirement for a summary. GET /api/me is allowed while limited and must
 * answer even when the setting cannot be read (it only informs; the gate is the
 * one that refuses, and it fails closed), so an unreadable setting reads as none
 * here. A lost database connection is still an error the client retries.
 */
async function readRequirement() {
  try {
    return normalizeMfaRequirement((await getSetting('auth')).mfaRequirement);
  } catch (error) {
    if (isConnectionError(error)) throw error;
    logger.warn({ error }, 'Could not read the two-step verification requirement for /api/me');
    return normalizeMfaRequirement(undefined);
  }
}

export interface MfaPerson {
  id: string;
  role: UserRole;
}

/** The summary for GET /api/me, and the pieces the status adds. */
export async function mfaSummaryFor(
  person: MfaPerson,
  facts: SessionMfaFacts | null | undefined,
  now = new Date(),
): Promise<{ summary: MfaSummary; state: MfaPersonState }> {
  const [state, requirement] = await Promise.all([
    loadMfaPersonState(person.id),
    readRequirement(),
  ]);
  const evaluation = evaluateMfa({
    role: person.role,
    authMethod: facts?.authMethod ?? null,
    twoFactorEnabled: facts?.twoFactorEnabled ?? false,
    accountCreatedAt: facts?.userCreatedAt ?? new Date(0),
    requirement,
    now,
  });
  const methods: MfaMethod[] = [
    ...(state.totp?.confirmed ? (['totp'] as const) : []),
    ...(state.passkeys.length > 0 ? (['passkey'] as const) : []),
  ];
  // An account with no password is never required to, and never limited.
  const required = evaluation.required && state.credential;
  return {
    state,
    summary: {
      eligible: state.credential,
      enrolled: methods.length > 0,
      methods,
      recoveryCodesLeft: await recoveryCodesLeft(state),
      required,
      deadline: required ? (evaluation.deadline?.toISOString() ?? null) : null,
      limited: evaluation.candidate && state.credential,
    },
  };
}

export async function mfaStatusFor(
  person: MfaPerson,
  facts: SessionMfaFacts | null | undefined,
): Promise<MfaStatus> {
  const { summary, state } = await mfaSummaryFor(person, facts);
  return {
    ...summary,
    passkeys: state.passkeys,
    lockedUntil:
      state.totp?.lockedUntil && state.totp.lockedUntil.getTime() > Date.now()
        ? state.totp.lockedUntil.toISOString()
        : null,
  };
}
