import { eq, schema } from '@oci/db';
import type { AdminMfaStatus, UserRole } from '@oci/shared';
import { evaluateMfa } from '../../auth/mfa.js';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { notifyMfaChange } from '../mfa/notify.js';
import { currentRequirement } from '../mfa/requirement.js';
import { resetMfaState } from '../mfa/reset.js';
import { loadMfaPersonState, recoveryCodesLeft } from '../mfa/state.js';
import type { AdminUserActor } from './mutations.js';

/**
 * Two-step verification on the account page of People → Users (v0.14, #399):
 * what a person has set up (never a secret or a code), and the administrator's
 * reset for somebody who lost their authenticator and their recovery codes.
 */
export async function adminMfaStatus(target: {
  id: string;
  role: string;
  createdAt: Date;
}): Promise<AdminMfaStatus> {
  const [state, requirement] = await Promise.all([
    loadMfaPersonState(target.id),
    currentRequirement(),
  ]);
  const evaluation = evaluateMfa({
    role: target.role as UserRole,
    authMethod: null,
    twoFactorEnabled: false,
    accountCreatedAt: target.createdAt,
    requirement,
    now: new Date(),
  });
  const required = evaluation.required && state.credential;
  return {
    eligible: state.credential,
    totp: Boolean(state.totp?.confirmed),
    passkeys: state.passkeys.length,
    recoveryCodesLeft: await recoveryCodesLeft(state),
    lockedUntil:
      state.totp?.lockedUntil && state.totp.lockedUntil.getTime() > Date.now()
        ? state.totp.lockedUntil.toISOString()
        : null,
    required,
    deadline: required ? (evaluation.deadline?.toISOString() ?? null) : null,
  };
}

/**
 * Resets another person's two-step verification: their authenticator, recovery
 * codes and passkeys go, and so do their sessions. Audited `user.mfa.reset`
 * (who, whose, what was removed) and the person is emailed, so a reset nobody
 * asked for is noticed. Not on oneself: an administrator who cannot sign in
 * uses the command line (docs/OPERATIONS.md, "Getting back in when sign-on fails").
 */
export async function adminResetMfa(actor: AdminUserActor, targetId: string) {
  if (actor.id === targetId) {
    throw validationFailed(
      'You cannot reset your own two-step verification here. Turn it off under Settings → Account, or ask another administrator.',
    );
  }
  const [target] = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, targetId))
    .limit(1);
  if (!target) throw notFound('User not found');

  const outcome = await resetMfaState(targetId);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.mfa.reset',
    targetType: 'user',
    targetId,
    metadata: { email: target.email, ...outcome },
  });
  notifyMfaChange(target, 'reset_by_administrator');
  return { ok: true as const, sessionsEnded: outcome.sessionsEnded };
}
