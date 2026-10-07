import { and, eq, schema, sql } from '@oci/db';
import type { createUserSchema, updateUserSchema } from '@oci/shared';
import type { z } from 'zod';
import { auth } from '../../auth/index.js';
import { isEmailVerificationEnforced } from '../../auth/policy.js';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { recordDeletions } from '../compliance/deletions.js';
import {
  HELD_ACCOUNT_DELETION_MESSAGE,
  HELD_SELF_DELETION_MESSAGE,
  isLegalHoldViolation,
  isOnLegalHold,
} from '../compliance/holds.js';
import {
  administratorRemains,
  LAST_ADMIN_BAN_MESSAGE,
  LAST_ADMIN_ROLE_MESSAGE,
  lockAdministrators,
} from './last-admin.js';

export const LAST_ADMIN_DELETION_MESSAGE =
  'This is the last administrator account, so it cannot be deleted. Make someone else an administrator first.';

export interface AdminUserActor {
  id: string;
  email: string;
}

export async function createUser(actor: AdminUserActor, input: z.infer<typeof createUserSchema>) {
  // Resolve before creating anything; an unavailable policy is not an exemption.
  const verificationRequired = await isEmailVerificationEnforced();
  const [existing] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, input.email))
    .limit(1);

  if (existing) throw conflict('A user with that email already exists');

  const created = await auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: input.role === 'admin' ? 'admin' : 'user',
    },
  });

  // Better Auth's create-user API accepts its built-in admin/user presets.
  // Apply OCI's additional validated roles before returning or auditing success.
  if (input.role !== 'admin' && input.role !== 'user') {
    await db
      .update(schema.user)
      .set({ role: input.role })
      .where(eq(schema.user.id, created.user.id));
  }

  if (verificationRequired) {
    try {
      await auth.api.sendVerificationEmail({
        body: { email: input.email, callbackURL: '/' },
      });
    } catch {
      logger.warn(
        { userId: created.user.id },
        'Verification request failed; account remains unverified',
      );
    }
  } else {
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, created.user.id));
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.create',
    targetType: 'user',
    targetId: created.user.id,
    metadata: { email: input.email, role: input.role },
  });

  return { id: created.user.id };
}

export async function updateUser(
  actor: AdminUserActor,
  targetId: string,
  patch: z.infer<typeof updateUserSchema>,
) {
  // A demotion or a ban can take an administrator away: like deletion, it
  // locks every administrator first and refuses to leave none, so two
  // administrators demoting or banning each other at once cannot both
  // succeed (#304).
  const demotes = patch.role !== undefined && patch.role !== 'admin';
  const bans = patch.banned === true;
  const { target, updated, change } = await db.transaction(async (tx) => {
    const admins = demotes || bans ? await lockAdministrators(tx) : [];
    const [target] = await tx
      .select({
        id: schema.user.id,
        email: schema.user.email,
        name: schema.user.name,
        role: schema.user.role,
        banned: schema.user.banned,
        banReason: schema.user.banReason,
      })
      .from(schema.user)
      .where(eq(schema.user.id, targetId))
      .limit(1)
      .for('update');

    if (!target) throw notFound('User not found');
    if (targetId === actor.id && patch.role && patch.role !== 'admin') {
      throw validationFailed('You cannot remove your own administrator role');
    }
    if (targetId === actor.id && patch.banned) {
      throw validationFailed('You cannot ban your own account');
    }
    // Only an administrator who can sign in is taken away by this change.
    const working = target.role === 'admin' && !target.banned;
    if (working && (demotes || bans) && !administratorRemains(admins, [targetId])) {
      throw conflict(demotes ? LAST_ADMIN_ROLE_MESSAGE : LAST_ADMIN_BAN_MESSAGE);
    }

    // A reason belongs to a ban: an account that is not banned after this
    // change keeps none, whether it was just unbanned with only
    // `{"banned": false}` (which left the old reason stored, #350) or sent a
    // reason without a ban. The Users page sends `banReason: null` with an
    // unban; the API alone did not. The change recorded below is what was
    // applied, so the entry says the reason was cleared.
    const bannedAfter = patch.banned ?? target.banned;
    const clearsReason = !bannedAfter && (target.banReason !== null || patch.banReason != null);
    const change = clearsReason ? { ...patch, banReason: null } : patch;

    const [updated] = await tx
      .update(schema.user)
      .set({
        ...(change.name !== undefined && { name: change.name }),
        ...(change.role !== undefined && { role: change.role }),
        ...(change.banned !== undefined && { banned: change.banned }),
        ...(change.banReason !== undefined && { banReason: change.banReason }),
      })
      .where(eq(schema.user.id, targetId))
      .returning({ id: schema.user.id });
    return { target, updated, change };
  });

  // A ban that leaves sessions alive is not a ban until they expire. Bulk ban
  // already ends them; a single-account ban must too.
  if (patch.banned === true) {
    await db.delete(schema.session).where(eq(schema.session.userId, targetId));
  }

  // A role change is access control; record it under its protected action so
  // routine audit retention cannot prune it with ordinary profile edits. It is
  // recorded once: the role is left out of `user.update`, which is written only
  // when something else changed too, so one role change is one entry and one
  // webhook (#140).
  //
  // Both name the account by its email as well as its ID, and `user.update`
  // records each changed value as it was (`before`), as #221 and #258 did for
  // other changes (#323): the Target column showed only an ID, a ban's entry
  // could not be found by the email once the account was deleted, and an
  // unban did not say which reason it lifted.
  const roleChanged = change.role !== undefined && change.role !== target.role;
  // A ban or an unban is recorded under its own action (#375): both were
  // `user.update`, so the audit list and Recent activity could not tell them
  // apart without opening Details. Like the role, the ban and its reason are
  // left out of `user.update`, which is written only when something else
  // changed too. A reason edited on an account that stays banned is not a ban
  // or an unban and stays a `user.update`.
  const banChanged = change.banned !== undefined && change.banned !== Boolean(target.banned);
  const updateMetadata: Record<string, unknown> = { ...change };
  if (roleChanged) delete updateMetadata.role;
  if (banChanged) {
    delete updateMetadata.banned;
    delete updateMetadata.banReason;
  }
  if (Object.keys(updateMetadata).length > 0) {
    const before = Object.fromEntries(
      (['name', 'role', 'banned', 'banReason'] as const)
        .filter((key) => key in updateMetadata)
        .map((key) => [key, target[key]]),
    );
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.update',
      targetType: 'user',
      targetId,
      metadata: { email: target.email, ...updateMetadata, before },
    });
  }

  if (banChanged) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: change.banned ? 'user.ban' : 'user.unban',
      targetType: 'user',
      targetId,
      // The same keys `user.update` recorded for it, so an entry from before
      // this change reads the same: what it became, and what it replaced.
      metadata: {
        email: target.email,
        banned: change.banned,
        banReason: change.banReason ?? null,
        before: { banned: Boolean(target.banned), banReason: target.banReason },
      },
    });
  }

  if (roleChanged) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.role.change',
      targetType: 'user',
      targetId,
      metadata: { email: target.email, from: target.role, to: change.role },
    });
  }

  return { id: updated?.id };
}

export async function revokeUserSessions(actor: AdminUserActor, targetId: string) {
  // Named by email too, as a role change or ban is (#323).
  const [target] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, targetId))
    .limit(1);
  const ended = await db
    .delete(schema.session)
    .where(eq(schema.session.userId, targetId))
    .returning({ id: schema.session.id });
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.revoke_sessions',
    targetType: 'user',
    targetId,
    // How many sessions this ended, so the entry says what it did (#148).
    metadata: { ...(target && { email: target.email }), sessionsEnded: ended.length },
  });
  return { ok: true, sessionsEnded: ended.length };
}

export const LAST_ADMIN_SELF_DELETION_MESSAGE =
  'You are the last administrator, so your account cannot be deleted. Make someone else an administrator first.';

/**
 * Deleting an account and everything it owns, by an administrator (People →
 * Users) or, with `self`, by the person themselves (Settings → Account,
 * v0.10). Both refuse an account on legal hold and the last administrator,
 * and write one `user.delete` deletion event in the deleting transaction; a
 * person's own deletion is recorded with `reason: 'user'` and `self: true`.
 * Only the self path may delete the caller's own account: an administrator
 * cannot remove themselves from People by mistake.
 *
 * Usage is kept without the person (migration 0038): usage events, daily
 * totals and limit refusals lose their `user_id`, so instance reports and
 * budget history do not change after the fact. Only in-flight quota
 * reservations, which hold an estimate rather than measured use, go with the
 * account.
 */
export async function deleteUser(
  actor: AdminUserActor,
  targetId: string,
  options: { self?: boolean; ipAddress?: string | null } = {},
) {
  const self = options.self === true;
  if (self && targetId !== actor.id) throw validationFailed('You can delete only your own account');
  if (!self && targetId === actor.id) {
    throw validationFailed('You cannot delete your own account');
  }
  const heldMessage = self ? HELD_SELF_DELETION_MESSAGE : HELD_ACCOUNT_DELETION_MESSAGE;
  // The database refuses too (a trigger, migration 0034), whichever path deletes;
  // checking first gives a clear reason.
  if (await isOnLegalHold(targetId)) throw conflict(heldMessage);

  try {
    await db.transaction(async (tx) => {
      // Lock every administrator first, so two administrators deleting each
      // other at the same time cannot both succeed and leave nobody in charge.
      // One who is banned does not count as remaining (#304).
      const admins = await lockAdministrators(tx);
      const [target] = await tx
        .select({ email: schema.user.email, role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.id, targetId))
        .limit(1)
        .for('update');
      if (!target) throw notFound('User not found');
      if (target.role === 'admin' && !administratorRemains(admins, [targetId])) {
        throw conflict(self ? LAST_ADMIN_SELF_DELETION_MESSAGE : LAST_ADMIN_DELETION_MESSAGE);
      }
      // Recorded first, in this transaction (the owner's email is read from the
      // row about to go): everything the account owned goes with it, counted.
      const [owned] = await tx.execute<Record<string, number>>(sql`
        select
          (select count(*) from "thread" where "user_id" = ${targetId})::int as conversations,
          (select count(*) from "message" where "user_id" = ${targetId})::int as messages,
          (select count(*) from "attachment" where "user_id" = ${targetId})::int as attachments,
          (select count(*) from "artifact" where "user_id" = ${targetId})::int as artifacts,
          (select count(*) from "project" where "user_id" = ${targetId})::int as projects,
          (select count(*) from "user_memory" where "user_id" = ${targetId})::int as memories,
          (select count(*) from "share_link" where "user_id" = ${targetId})::int as "shareLinks"
      `);
      await recordDeletions(tx, [
        {
          action: 'user.delete',
          actorUserId: actor.id,
          actorEmail: actor.email,
          id: targetId,
          ownerUserId: targetId,
          reason: self ? 'user' : 'admin',
          details: {
            ...Object.fromEntries(
              Object.entries(owned ?? {}).map(([key, value]) => [key, Number(value)]),
            ),
            ...(self ? { self: true } : {}),
          },
          ipAddress: options.ipAddress ?? null,
          // The account is gone; keep enough to say whose it was.
          legacy: { email: target.email, role: target.role, ...(self ? { self: true } : {}) },
        },
      ]);
      // The account row is locked, so no reservation can be added or settled
      // until this commits (both lock the owner first).
      await tx
        .delete(schema.usageEvent)
        .where(and(eq(schema.usageEvent.userId, targetId), eq(schema.usageEvent.pending, true)));
      await tx.delete(schema.user).where(eq(schema.user.id, targetId));
    });
  } catch (error) {
    if (isLegalHoldViolation(error)) throw conflict(heldMessage);
    throw error;
  }
  return { ok: true };
}
