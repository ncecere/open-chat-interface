import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { recordAudit } from '../audit.js';
import { clearSecondStepFailures } from './lockout.js';

/**
 * Taking two-step verification away from somebody who cannot use it (v0.14,
 * #399): an administrator under People → Users, or the operator on the command
 * line when no administrator can sign in. Nothing here decrypts anything, so it
 * works whatever AUTH_SECRET is, including a changed one.
 */
export interface ResetOutcome {
  sessionsEnded: number;
  /** An authenticator (and its recovery codes) was removed. */
  authenticator: boolean;
  passkeysRemoved: number;
}

/**
 * Removes the person's authenticator, recovery codes and passkeys, turns the
 * second step off and ends every session, in one transaction. They sign in with
 * the password and set it up again (or, under a requirement, are asked to).
 */
export async function resetMfaState(userId: string): Promise<ResetOutcome> {
  return db.transaction(async (tx) => {
    const removedTotp = await tx
      .delete(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, userId))
      .returning({ id: schema.twoFactor.id });
    const removedPasskeys = await tx
      .delete(schema.passkey)
      .where(eq(schema.passkey.userId, userId))
      .returning({ id: schema.passkey.id });
    await tx.update(schema.user).set({ twoFactorEnabled: false }).where(eq(schema.user.id, userId));
    const ended = await tx
      .delete(schema.session)
      .where(eq(schema.session.userId, userId))
      .returning({ id: schema.session.id });
    return {
      sessionsEnded: ended.length,
      authenticator: removedTotp.length > 0,
      passkeysRemoved: removedPasskeys.length,
    };
  });
}

async function findByEmail(email: string) {
  const [user] = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.email, email.trim().toLowerCase()))
    .limit(1);
  return user ?? null;
}

export class NoSuchPersonError extends Error {
  constructor(email: string) {
    super(`No user found with email ${email}`);
    this.name = 'NoSuchPersonError';
  }
}

/** `admin:reset-mfa <email>`: everything of one person's, and their sessions. Audited `user.mfa_reset_cli`. */
export async function cliResetMfa(email: string): Promise<ResetOutcome & { email: string }> {
  const user = await findByEmail(email);
  if (!user) throw new NoSuchPersonError(email);
  const outcome = await resetMfaState(user.id);
  await recordAudit({
    action: 'user.mfa_reset_cli',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: user.email, mode: 'reset', ...outcome },
  });
  return { ...outcome, email: user.email };
}

/**
 * `admin:reset-mfa <email> --unlock`: only clears the failure count and the
 * lock of the second step. A holder of the password can otherwise keep it
 * locked for 15 minutes at a time with wrong codes.
 */
export async function cliUnlockMfa(email: string): Promise<{ email: string }> {
  const user = await findByEmail(email);
  if (!user) throw new NoSuchPersonError(email);
  await clearSecondStepFailures(user.id);
  await recordAudit({
    action: 'user.mfa_reset_cli',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: user.email, mode: 'unlock' },
  });
  return { email: user.email };
}

/**
 * `admin:reset-mfa --all --yes`, for a changed AUTH_SECRET: every authenticator
 * and set of recovery codes is encrypted with it and cannot be read any more, so
 * everybody's authenticator is removed and the second step turned off. Passkeys
 * do not depend on the secret and are kept; sessions end (a changed secret has
 * already invalidated their cookies).
 */
export async function cliResetAllAuthenticators(): Promise<{
  authenticators: number;
  sessionsEnded: number;
}> {
  const outcome = await db.transaction(async (tx) => {
    const removed = await tx.delete(schema.twoFactor).returning({ id: schema.twoFactor.id });
    await tx
      .update(schema.user)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.user.twoFactorEnabled, true));
    const ended = await tx.delete(schema.session).returning({ id: schema.session.id });
    return { authenticators: removed.length, sessionsEnded: ended.length };
  });
  await recordAudit({
    action: 'user.mfa_reset_cli',
    targetType: 'instance',
    metadata: { mode: 'all', ...outcome },
  });
  return outcome;
}

/** For tests: how many people have the second step on. */
export async function peopleWithSecondStep(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.user)
    .where(eq(schema.user.twoFactorEnabled, true));
  return row?.n ?? 0;
}
