import { and, eq, schema } from '@oci/db';
import type { DeleteOwnAccountInput, UserRole } from '@oci/shared';
import { auth } from '../auth/index.js';
import { db } from '../db/index.js';
import { forbidden, validationFailed } from '../lib/errors.js';
import { deleteUser } from './admin-users/mutations.js';
import { recordAudit } from './audit.js';
import { assertRoleFeature } from './role-features.js';

/**
 * Self-service account deletion (Settings → Account, v0.10).
 *
 * Off unless the person's role allows it (Roles & access, "Delete own
 * account"; off for every role by default). The person types their email,
 * and an account with a password also enters it: a session left open on a
 * shared computer is not enough to delete the account. An account that signs
 * in only through the organisation has no password to ask for; the page
 * explains that signing in again later creates a new, empty account.
 *
 * The deletion itself is the administrator's (`deleteUser`): the same legal
 * hold and last-administrator refusals, the same cascade, and one `user.delete`
 * entry with `self: true`. Better Auth's own delete-user endpoint stays off.
 */
export interface DeletingPerson {
  id: string;
  email: string;
  role: UserRole;
}

/** True once the typed text is the account's email, ignoring case and outer spaces. */
export function emailConfirmed(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** The stored password hash, or null for an account without a password. */
async function passwordHashOf(userId: string): Promise<string | null> {
  const [credential] = await db
    .select({ password: schema.account.password })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')))
    .limit(1);
  return credential?.password ?? null;
}

async function passwordMatches(hash: string, password: string): Promise<boolean> {
  const context = await auth.$context;
  return context.password.verify({ hash, password });
}

/** True for a session an administrator opened as this person. */
async function impersonated(sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const [row] = await db
    .select({ impersonatedBy: schema.session.impersonatedBy })
    .from(schema.session)
    .where(eq(schema.session.id, sessionId))
    .limit(1);
  return Boolean(row?.impersonatedBy);
}

export async function deleteOwnAccount(
  person: DeletingPerson,
  input: DeleteOwnAccountInput,
  request: { ipAddress: string | null; sessionId: string | null },
): Promise<{ ok: true }> {
  const { ipAddress } = request;
  await assertRoleFeature(person.role, 'accountDeletion');
  // Only the person may decide this. An administrator acting as them deletes
  // under People, where the entry names the administrator.
  if (await impersonated(request.sessionId)) {
    throw forbidden('An administrator session cannot delete this account. Use People → Users.');
  }
  if (!emailConfirmed(input.confirmEmail, person.email)) {
    throw validationFailed('Type your email address exactly as shown to confirm.');
  }

  const hash = await passwordHashOf(person.id);
  if (hash) {
    if (!input.password) throw validationFailed('Enter your password to delete your account.');
    if (!(await passwordMatches(hash, input.password))) {
      await recordAudit({
        actorUserId: person.id,
        actorEmail: person.email,
        action: 'user.delete.failure',
        targetType: 'user',
        targetId: person.id,
        ipAddress,
        metadata: { self: true, reason: 'invalid_password' },
      });
      throw validationFailed('Your password is not correct.');
    }
  }

  await deleteUser({ id: person.id, email: person.email }, person.id, { self: true, ipAddress });
  return { ok: true };
}
