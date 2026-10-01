import { eq, schema } from '@oci/db';
import type { createUserSchema, updateUserSchema } from '@oci/shared';
import type { z } from 'zod';
import { auth } from '../../auth/index.js';
import { isEmailVerificationEnforced } from '../../auth/policy.js';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';

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
  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, targetId))
    .limit(1);

  if (!target) throw notFound('User not found');
  if (targetId === actor.id && patch.role && patch.role !== 'admin') {
    throw validationFailed('You cannot remove your own administrator role');
  }
  if (targetId === actor.id && patch.banned) {
    throw validationFailed('You cannot ban your own account');
  }

  const [updated] = await db
    .update(schema.user)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.role !== undefined && { role: patch.role }),
      ...(patch.banned !== undefined && { banned: patch.banned }),
      ...(patch.banReason !== undefined && { banReason: patch.banReason }),
    })
    .where(eq(schema.user.id, targetId))
    .returning({ id: schema.user.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.update',
    targetType: 'user',
    targetId,
    metadata: patch,
  });

  // A role change is access control; record it under its protected action so
  // routine audit retention cannot prune it with ordinary profile edits.
  if (patch.role !== undefined && patch.role !== target.role) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.role.change',
      targetType: 'user',
      targetId,
      metadata: { from: target.role, to: patch.role },
    });
  }

  return { id: updated?.id };
}

export async function revokeUserSessions(actor: AdminUserActor, targetId: string) {
  await db.delete(schema.session).where(eq(schema.session.userId, targetId));
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.revoke_sessions',
    targetType: 'user',
    targetId,
  });
  return { ok: true };
}

export async function deleteUser(actor: AdminUserActor, targetId: string) {
  if (targetId === actor.id) {
    throw validationFailed('You cannot delete your own account');
  }

  await db.delete(schema.user).where(eq(schema.user.id, targetId));
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.delete',
    targetType: 'user',
    targetId,
  });
  return { ok: true };
}
