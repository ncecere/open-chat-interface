import { inArray, schema } from '@oci/db';
import { USER_ROLES } from '@oci/shared';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { conflict, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { administratorRemains, LAST_ADMIN_BULK_MESSAGE, lockAdministrators } from './last-admin.js';
import type { AdminUserActor } from './mutations.js';

/** Bound each operation so one request cannot rewrite the entire directory. */
export const bulkActionSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['set_role', 'ban', 'unban', 'revoke_sessions']),
  role: z.enum(USER_ROLES).optional(),
  reason: z.string().trim().max(500).optional(),
});

export async function applyBulkUserAction(
  actor: AdminUserActor,
  input: z.infer<typeof bulkActionSchema>,
  ipAddress: string | null,
) {
  if (input.action === 'set_role' && !input.role) {
    throw validationFailed('Choose a role to apply.', [
      { path: ['role'], message: 'Required when setting a role' },
    ]);
  }

  // Do not let an administrator remove their own access mid-operation.
  const targets = input.userIds.filter((id) => id !== actor.id);
  const skippedSelf = targets.length !== input.userIds.length;
  if (targets.length === 0) {
    throw validationFailed('Select an account other than your own.', [
      { path: ['userIds'], message: 'Your own account cannot be changed in bulk' },
    ]);
  }

  // `affected` counts accounts for every action; `sessionsEnded` says how many
  // sessions a sign-out or ban ended. Sign-out used to report sessions as
  // `affected`, so signing out accounts with none read as nothing done (#145).
  let affected = 0;
  let sessionsEnded: number | undefined;
  // Each account's role before the change, as a single change records
  // `{from, to}` (#221). Read under the update's row locks, so it is the
  // role this change replaced.
  let previousRoles: Record<string, string> | undefined;
  if (input.action === 'set_role' && input.role) {
    const role = input.role;
    previousRoles = await db.transaction(async (tx) => {
      // A demotion locks every administrator first and refuses to leave none,
      // as a single change and deletion do (#304).
      const admins = role === 'admin' ? [] : await lockAdministrators(tx);
      const before = await tx
        .select({ id: schema.user.id, role: schema.user.role })
        .from(schema.user)
        .where(inArray(schema.user.id, targets))
        .orderBy(schema.user.id)
        .for('update');
      if (role !== 'admin') refuseLeavingNoAdministrator(admins, targets);
      await tx.update(schema.user).set({ role }).where(inArray(schema.user.id, targets));
      return Object.fromEntries(before.map((row) => [row.id, row.role]));
    });
    affected = Object.keys(previousRoles).length;
  } else if (input.action === 'ban' || input.action === 'unban') {
    const banned = input.action === 'ban';
    const rows = await db.transaction(async (tx) => {
      // A ban locks every administrator first and refuses to leave none who
      // can sign in, as a single ban and deletion do (#304).
      if (banned) refuseLeavingNoAdministrator(await lockAdministrators(tx), targets);
      return tx
        .update(schema.user)
        .set({ banned, banReason: banned ? (input.reason ?? null) : null })
        .where(inArray(schema.user.id, targets))
        .returning({ id: schema.user.id });
    });
    affected = rows.length;

    // A ban that leaves the session alive is not a ban until it expires.
    if (banned) sessionsEnded = await endSessions(targets);
  } else {
    const accounts = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(inArray(schema.user.id, targets));
    affected = accounts.length;
    sessionsEnded = await endSessions(targets);
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: `user.bulk.${input.action}`,
    targetType: 'user',
    targetId: null,
    ipAddress,
    metadata: {
      requested: input.userIds.length,
      affected,
      ...(sessionsEnded !== undefined ? { sessionsEnded } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(previousRoles ? { previousRoles } : {}),
      // Name the accounts so the audit entry can be checked afterwards.
      userIds: targets,
    },
  });
  return { affected, skippedSelf, ...(sessionsEnded !== undefined ? { sessionsEnded } : {}) };
}

/**
 * Refuses the whole operation when it would leave no administrator who can
 * sign in: every administrator among `targets` stops being one (#304).
 */
function refuseLeavingNoAdministrator(
  admins: ReadonlyArray<{ id: string; banned: boolean }>,
  targets: readonly string[],
) {
  const leaving = admins.filter((admin) => !admin.banned && targets.includes(admin.id));
  if (leaving.length > 0 && !administratorRemains(admins, targets)) {
    throw conflict(LAST_ADMIN_BULK_MESSAGE);
  }
}

/** Ends every session of these accounts and says how many there were. */
async function endSessions(userIds: string[]): Promise<number> {
  const rows = await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, userIds))
    .returning({ id: schema.session.id });
  return rows.length;
}
