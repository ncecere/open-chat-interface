import { eq, schema, sql } from '@oci/db';
import { MFA_LOCKOUT_ATTEMPTS, MFA_LOCKOUT_SECONDS } from '../../auth/mfa.js';
import { db } from '../../db/index.js';
import { rateLimited } from '../../lib/errors.js';

/**
 * The account lockout of the second step for the paths where the plugin counts
 * nothing: disabling it and regenerating recovery codes while signed in (the
 * plugin counts failures only while signing in). Same counters, same limits
 * (`MFA_LOCKOUT_ATTEMPTS` consecutive failures lock it for
 * `MFA_LOCKOUT_SECONDS`, across challenges and factors), so a stolen session is
 * not an unlimited oracle for authenticator and recovery codes.
 */
export const SECOND_STEP_LOCKED_MESSAGE =
  'Too many wrong codes. Two-step verification is locked for a while. Try again later, or ask an administrator to reset it.';

/** Throws a 429 while the second step is locked; clears a lock that has run out. */
export async function assertSecondStepNotLocked(userId: string): Promise<void> {
  const [row] = await db
    .select({ lockedUntil: schema.twoFactor.lockedUntil })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, userId))
    .limit(1);
  if (!row?.lockedUntil) return;
  const remaining = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000);
  if (remaining > 0) throw rateLimited(SECOND_STEP_LOCKED_MESSAGE, remaining);
  await clearSecondStepFailures(userId);
}

/** One more wrong code, counted atomically; locks the second step at the limit. */
export async function recordSecondStepFailure(userId: string): Promise<void> {
  await db
    .update(schema.twoFactor)
    .set({
      failedVerificationCount: sql`${schema.twoFactor.failedVerificationCount} + 1`,
      lockedUntil: sql`case when ${schema.twoFactor.failedVerificationCount} + 1 >= ${MFA_LOCKOUT_ATTEMPTS} then now() + make_interval(secs => ${MFA_LOCKOUT_SECONDS}) else ${schema.twoFactor.lockedUntil} end`,
    })
    .where(eq(schema.twoFactor.userId, userId));
}

/** After a right code, or for an administrator or the CLI unlocking someone. */
export async function clearSecondStepFailures(userId: string): Promise<void> {
  await db
    .update(schema.twoFactor)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(eq(schema.twoFactor.userId, userId));
}
