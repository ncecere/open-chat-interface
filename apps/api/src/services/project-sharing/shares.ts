import { and, asc, count, eq, schema, sql } from '@oci/db';
import {
  MAX_DIRECT_INBOUND_SHARES_PER_USER,
  MAX_PROJECTS_PER_USER,
  MAX_SHARES_PER_PROJECT,
  PROJECT_SHARE_RATE_LIMIT_PER_MINUTE,
  type ProjectAccessInfo,
  type ProjectShare,
  type ProjectShareErrorReason,
  type ProjectSharePermission,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound, rateLimited, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { isGroupMember } from '../groups/membership.js';
import { lockLifecycleOwner } from '../lifecycle/owner-lock.js';
import { consumeRateLimit } from '../limits/rate-limit.js';
import { roleFeatures } from '../role-features.js';
import { projectAccess, requireProjectAccess } from './access.js';
import { auditAccessRevoked, type ReconcileResult, reconcileProject } from './reconcile.js';
import { assertNoOlderReplica } from './upgrade-guard.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who is acting: the person, as the routes know them. */
export interface ShareActor {
  id: string;
  role: UserRole;
  email?: string;
  ipAddress?: string | null;
}

/** A refusal that says why in `details.reason`, so a client can branch without parsing a sentence. */
function refused(
  kind: 'conflict' | 'validation',
  reason: ProjectShareErrorReason,
  message: string,
) {
  return kind === 'conflict'
    ? conflict(message, { reason })
    : validationFailed(message, { reason });
}

/**
 * Exact-email lookups and share writes are each limited per person (30 a
 * minute, fixed): a lookup that answers "no such account" is an
 * account-existence oracle for any signed-in person, as a manager adding by
 * email is, so it is slowed and accepted rather than hidden (decision 8).
 */
async function limit(bucket: 'person-lookup' | 'project-share', actorId: string) {
  const result = await consumeRateLimit({
    bucket,
    identifier: actorId,
    limit: PROJECT_SHARE_RATE_LIMIT_PER_MINUTE,
  });
  if (!result.allowed) {
    throw rateLimited(
      'You are sharing too quickly. Try again in a moment.',
      result.retryAfterSeconds,
    );
  }
}

const iso = (value: Date) => value.toISOString();

/** The share list the owner sees: people with names and emails, groups with names and sizes. */
export async function listProjectShares(
  projectId: string,
  actorId: string,
): Promise<ProjectShare[]> {
  await requireProjectAccess(projectId, actorId, 'owner');
  const rows = await db
    .select({
      id: schema.projectShare.id,
      permission: schema.projectShare.permission,
      type: schema.projectShare.subjectType,
      userId: schema.projectShare.subjectUserId,
      groupId: schema.projectShare.subjectGroupId,
      createdAt: schema.projectShare.createdAt,
      updatedAt: schema.projectShare.updatedAt,
      userName: schema.user.name,
      userEmail: schema.user.email,
      groupName: schema.group.name,
      memberCount: sql<number>`(select count(*) from "group_member" as "gm_count"
        where "gm_count"."group_id" = "project_share"."subject_group_id")::int`,
    })
    .from(schema.projectShare)
    .leftJoin(schema.user, eq(schema.user.id, schema.projectShare.subjectUserId))
    .leftJoin(schema.group, eq(schema.group.id, schema.projectShare.subjectGroupId))
    .where(eq(schema.projectShare.projectId, projectId))
    .orderBy(asc(schema.projectShare.createdAt), asc(schema.projectShare.id));
  return rows.map(toShare);
}

type ShareRow = {
  id: string;
  permission: ProjectSharePermission;
  type: 'person' | 'group';
  userId: string | null;
  groupId: string | null;
  createdAt: Date;
  updatedAt: Date;
  userName: string | null;
  userEmail: string | null;
  groupName: string | null;
  memberCount: number | null;
};

function toShare(row: ShareRow): ProjectShare {
  return {
    id: row.id,
    permission: row.permission,
    subject:
      row.type === 'person'
        ? {
            type: 'person',
            userId: row.userId ?? '',
            name: row.userName ?? '',
            email: row.userEmail ?? '',
          }
        : {
            type: 'group',
            groupId: row.groupId ?? '',
            name: row.groupName ?? '',
            memberCount: Number(row.memberCount ?? 0),
          },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** One share as the owner sees it. */
async function shareView(executor: Pick<typeof db, 'select'>, shareId: string) {
  const [row] = await executor
    .select({
      id: schema.projectShare.id,
      permission: schema.projectShare.permission,
      type: schema.projectShare.subjectType,
      userId: schema.projectShare.subjectUserId,
      groupId: schema.projectShare.subjectGroupId,
      createdAt: schema.projectShare.createdAt,
      updatedAt: schema.projectShare.updatedAt,
      userName: schema.user.name,
      userEmail: schema.user.email,
      groupName: schema.group.name,
      memberCount: sql<number>`(select count(*) from "group_member" as "gm_count"
        where "gm_count"."group_id" = "project_share"."subject_group_id")::int`,
    })
    .from(schema.projectShare)
    .leftJoin(schema.user, eq(schema.user.id, schema.projectShare.subjectUserId))
    .leftJoin(schema.group, eq(schema.group.id, schema.projectShare.subjectGroupId))
    .where(eq(schema.projectShare.id, shareId))
    .limit(1);
  if (!row) throw notFound('Share not found');
  return toShare(row);
}

/**
 * What anyone with access may see about who else has it: their own level, the
 * owner's display name, and counts. Never the people, their emails or the groups.
 */
export async function projectAccessInfo(
  projectId: string,
  userId: string,
): Promise<ProjectAccessInfo> {
  const access = await requireProjectAccess(projectId, userId, 'viewer');
  const [row] = await db
    .select({
      // Written with explicit aliases: inside a select list Drizzle renders column
      // references unqualified, which a correlated subquery would resolve against
      // its own table instead of the outer project row.
      ownerName: sql<string>`(select "o"."name" from "user" as "o" where "o"."id" = "project"."user_id")`,
      people: sql<number>`(select count(*) from "project_share" as "s"
        where "s"."project_id" = "project"."id" and "s"."subject_type" = 'person')::int`,
      groups: sql<number>`(select count(*) from "project_share" as "s"
        where "s"."project_id" = "project"."id" and "s"."subject_type" = 'group')::int`,
      direct: sql<boolean>`exists (select 1 from "project_share" as "s"
        where "s"."project_id" = "project"."id" and "s"."subject_user_id" = ${userId})`,
    })
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .limit(1);
  if (!row) throw notFound('Project not found');
  return {
    access,
    ownerName: row.ownerName,
    personShares: Number(row.people),
    groupShares: Number(row.groups),
    canLeave: access !== 'owner' && row.direct,
  };
}

export type ShareSubjectInput =
  | { type: 'person'; email: string }
  | { type: 'group'; groupId: string };

/**
 * Shares a project with a person (found by exact email) or with a group the
 * owner belongs to, as viewer or editor. Owner only (403 for others with access,
 * 404 for none).
 *
 * Checked in this order so no answer leaks to someone who may not know it:
 * access (404/403), the rate limit, the upgrade guard, then the subject. Counted
 * under the project row lock (and the target's, for the inbound limit), so two
 * concurrent shares cannot both pass a limit.
 */
export async function createProjectShare(params: {
  projectId: string;
  actor: ShareActor;
  subject: ShareSubjectInput;
  permission: ProjectSharePermission;
}): Promise<ProjectShare> {
  const { projectId, actor, subject, permission } = params;
  await requireProjectAccess(projectId, actor.id, 'owner');
  await limit('project-share', actor.id);
  if (subject.type === 'person') await limit('person-lookup', actor.id);
  await assertNoOlderReplica();

  let target: { id: string; email: string } | null = null;
  if (subject.type === 'person') {
    const [found] = await db
      .select({ id: schema.user.id, email: schema.user.email })
      .from(schema.user)
      .where(sql`lower(${schema.user.email}) = ${subject.email.trim().toLowerCase()}`)
      .limit(1);
    if (!found)
      throw refused('validation', 'person_not_found', 'No account has that email address.');
    if (found.id === actor.id) {
      throw refused('validation', 'cannot_share_with_self', 'You already own this project.');
    }
    target = found;
  } else if (!(await isGroupMember(subject.groupId, actor.id))) {
    // Also what an unknown group id answers: nothing says whether the group exists.
    throw refused(
      'validation',
      'not_a_group_member',
      'You can share a project only with a group you belong to.',
    );
  }

  const shareId = await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, actor.id))) throw notFound('Project not found');
    const [locked] = await tx
      .select({ id: schema.project.id, userId: schema.project.userId })
      .from(schema.project)
      .where(eq(schema.project.id, projectId))
      .for('update');
    if (!locked) throw notFound('Project not found');
    // The owner may have changed while this waited for the lock.
    if (locked.userId !== actor.id) throw notFound('Project not found');
    if (target) {
      // Serialises inbound shares to this person, so the count below is exact.
      await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, target.id))
        .for('no key update');
    }
    const [existingShares] = await tx
      .select({ value: count() })
      .from(schema.projectShare)
      .where(eq(schema.projectShare.projectId, projectId));
    if ((existingShares?.value ?? 0) >= MAX_SHARES_PER_PROJECT) {
      throw refused(
        'validation',
        'share_limit',
        `A project can be shared with at most ${MAX_SHARES_PER_PROJECT} people and groups (a group counts one). Remove a share to make room.`,
      );
    }
    if (target) {
      const [inbound] = await tx
        .select({ value: count() })
        .from(schema.projectShare)
        .where(eq(schema.projectShare.subjectUserId, target.id));
      if ((inbound?.value ?? 0) >= MAX_DIRECT_INBOUND_SHARES_PER_USER) {
        throw refused(
          'validation',
          'inbound_limit',
          `That person already has ${MAX_DIRECT_INBOUND_SHARES_PER_USER} projects shared with them.`,
        );
      }
    }
    const [duplicate] = await tx
      .select({ id: schema.projectShare.id })
      .from(schema.projectShare)
      .where(
        and(
          eq(schema.projectShare.projectId, projectId),
          target
            ? eq(schema.projectShare.subjectUserId, target.id)
            : eq(
                schema.projectShare.subjectGroupId,
                subject.type === 'group' ? subject.groupId : '',
              ),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw refused(
        'conflict',
        'already_shared',
        'This project is already shared with them. Change their permission instead.',
      );
    }
    const [created] = await tx
      .insert(schema.projectShare)
      .values({
        projectId,
        subjectType: subject.type,
        subjectUserId: target?.id ?? null,
        subjectGroupId: subject.type === 'group' ? subject.groupId : null,
        permission,
        createdByUserId: actor.id,
      })
      .returning({ id: schema.projectShare.id });
    if (!created) throw new Error('Failed to create share');
    return created.id;
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email ?? null,
    action: 'project.share.create',
    targetType: 'project',
    targetId: projectId,
    metadata: subjectMetadata(subject, target, permission),
    ipAddress: actor.ipAddress ?? null,
  });
  return shareView(db, shareId);
}

/** Subject and permission, never the project's name or content. */
function subjectMetadata(
  subject: ShareSubjectInput,
  target: { id: string; email: string } | null,
  permission: ProjectSharePermission,
): Record<string, unknown> {
  return subject.type === 'person'
    ? {
        subjectType: 'person',
        subjectUserId: target?.id ?? null,
        subjectEmail: target?.email ?? null,
        permission,
      }
    : { subjectType: 'group', subjectGroupId: subject.groupId, permission };
}

/**
 * Changes a share's permission. Owner only. Downgrading an editor to viewer
 * ends their editing at once: the files they added go to the owner (and, for a
 * group, the files of members who are no longer editors by any other share).
 */
export async function updateProjectShare(params: {
  projectId: string;
  shareId: string;
  actor: ShareActor;
  permission: ProjectSharePermission;
}): Promise<ProjectShare> {
  const { projectId, shareId, actor, permission } = params;
  await requireProjectAccess(projectId, actor.id, 'owner');
  await limit('project-share', actor.id);
  const outcome = await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, actor.id))) throw notFound('Project not found');
    await lockOwnedProject(tx, projectId, actor.id);
    const [share] = await tx
      .select()
      .from(schema.projectShare)
      .where(and(eq(schema.projectShare.id, shareId), eq(schema.projectShare.projectId, projectId)))
      .for('update');
    if (!share) throw notFound('Share not found');
    if (share.permission === permission) return { share, reconcile: null };
    await tx
      .update(schema.projectShare)
      .set({ permission, updatedAt: new Date() })
      .where(eq(schema.projectShare.id, shareId));
    const reconcile = permission === 'viewer' ? await reconcileProject(tx, projectId) : null;
    return { share, reconcile };
  });
  if (outcome.share.permission !== permission) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email ?? null,
      action: 'project.share.update',
      targetType: 'project',
      targetId: projectId,
      metadata: {
        subjectType: outcome.share.subjectType,
        subjectUserId: outcome.share.subjectUserId,
        subjectGroupId: outcome.share.subjectGroupId,
        permission,
        previousPermission: outcome.share.permission,
      },
      ipAddress: actor.ipAddress ?? null,
    });
    if (outcome.reconcile) await auditAccessRevoked(projectId, outcome.reconcile, 'share');
  }
  return shareView(db, shareId);
}

/**
 * Removes a share. Owner only. The conversations of people who now have no
 * access leave the project (nothing is deleted) and the files they added go to
 * the owner, in the same transaction.
 */
export async function deleteProjectShare(params: {
  projectId: string;
  shareId: string;
  actor: ShareActor;
}): Promise<ReconcileResult> {
  const { projectId, shareId, actor } = params;
  await requireProjectAccess(projectId, actor.id, 'owner');
  await limit('project-share', actor.id);
  const { share, result } = await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, actor.id))) throw notFound('Project not found');
    await lockOwnedProject(tx, projectId, actor.id);
    const [removed] = await tx
      .delete(schema.projectShare)
      .where(and(eq(schema.projectShare.id, shareId), eq(schema.projectShare.projectId, projectId)))
      .returning();
    if (!removed) throw notFound('Share not found');
    return { share: removed, result: await reconcileProject(tx, projectId) };
  });
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email ?? null,
    action: 'project.share.delete',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      subjectType: share.subjectType,
      subjectUserId: share.subjectUserId,
      subjectGroupId: share.subjectGroupId,
      permission: share.permission,
    },
    ipAddress: actor.ipAddress ?? null,
  });
  await auditAccessRevoked(projectId, result, 'share');
  return result;
}

/**
 * Leaves a project: removes the person's own direct share. The owner cannot
 * (409: transfer or delete), and a person whose access comes only through a
 * group cannot (409: a group manager removes them from the group).
 */
export async function leaveProject(params: {
  projectId: string;
  actor: ShareActor;
}): Promise<ReconcileResult> {
  const { projectId, actor } = params;
  const level = await requireProjectAccess(projectId, actor.id, 'viewer');
  if (level === 'owner') {
    throw conflict('You own this project. Transfer it to someone else or delete it.');
  }
  const { share, result } = await db.transaction(async (tx) => {
    if (!(await lockLifecycleOwner(tx, actor.id))) throw notFound('Project not found');
    // The project row first, as every mutation does.
    const [locked] = await tx
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.id, projectId))
      .for('update');
    if (!locked) throw notFound('Project not found');
    const [removed] = await tx
      .delete(schema.projectShare)
      .where(
        and(
          eq(schema.projectShare.projectId, projectId),
          eq(schema.projectShare.subjectUserId, actor.id),
        ),
      )
      .returning();
    if (!removed) {
      // Access is only through a group, or ended a moment ago.
      if (!(await projectAccess(tx, projectId, actor.id))) throw notFound('Project not found');
      throw refused(
        'conflict',
        'leave_via_group',
        'You have access through a group. Ask a manager of the group to remove you from it.',
      );
    }
    return { share: removed, result: await reconcileProject(tx, projectId) };
  });
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email ?? null,
    action: 'project.share.delete',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      subjectType: 'person',
      subjectUserId: share.subjectUserId,
      permission: share.permission,
      left: true,
    },
    ipAddress: actor.ipAddress ?? null,
  });
  await auditAccessRevoked(projectId, result, 'share');
  return result;
}

/** The project row, locked, and only if `ownerId` still owns it. */
async function lockOwnedProject(tx: Transaction, projectId: string, ownerId: string) {
  const [locked] = await tx
    .select({ id: schema.project.id, userId: schema.project.userId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .for('update');
  if (!locked || locked.userId !== ownerId) throw notFound('Project not found');
  return locked;
}

/**
 * Hands the project to a person who already holds a direct editor share. Owner
 * only. The old owner becomes a direct editor (so nothing of theirs is lost and
 * every file still belongs to the owner or an editor: no counters move). Refused
 * when the new owner already has MAX_PROJECTS_PER_USER projects, their role has
 * projects off, or the old owner already has MAX_DIRECT_INBOUND_SHARES_PER_USER
 * projects shared with them. Locks: the two user rows in id order, then the
 * project.
 */
export async function transferProject(params: {
  projectId: string;
  actor: ShareActor;
  email: string;
}): Promise<void> {
  const { projectId, actor } = params;
  await requireProjectAccess(projectId, actor.id, 'owner');
  await limit('project-share', actor.id);
  await limit('person-lookup', actor.id);
  await assertNoOlderReplica();

  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role, email: schema.user.email })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${params.email.trim().toLowerCase()}`)
    .limit(1);
  if (!target)
    throw refused('validation', 'person_not_found', 'No account has that email address.');
  if (target.id === actor.id) {
    throw refused('validation', 'cannot_share_with_self', 'You already own this project.');
  }
  if (!(await roleFeatures(target.role as UserRole)).projects) {
    throw refused(
      'validation',
      'transfer_target_projects_off',
      'Projects are turned off for that person, so they cannot own one.',
    );
  }

  await db.transaction(async (tx) => {
    // User rows in id order, then the project (docs/dev/database.md lock order).
    const [first, second] = [actor.id, target.id].sort();
    for (const id of [first, second]) {
      await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, id!))
        .for(id === target.id ? 'no key update' : 'key share');
    }
    await lockOwnedProject(tx, projectId, actor.id);
    const [share] = await tx
      .select()
      .from(schema.projectShare)
      .where(
        and(
          eq(schema.projectShare.projectId, projectId),
          eq(schema.projectShare.subjectUserId, target.id),
        ),
      )
      .for('update');
    if (share?.permission !== 'editor') {
      throw refused(
        'validation',
        'transfer_target_not_editor',
        'Share the project with them as an editor first, then transfer it.',
      );
    }
    const [owned] = await tx
      .select({ value: count() })
      .from(schema.project)
      .where(eq(schema.project.userId, target.id));
    if ((owned?.value ?? 0) >= MAX_PROJECTS_PER_USER) {
      throw refused(
        'validation',
        'transfer_target_project_limit',
        `That person already has ${MAX_PROJECTS_PER_USER} projects.`,
      );
    }
    const [inbound] = await tx
      .select({ value: count() })
      .from(schema.projectShare)
      .where(eq(schema.projectShare.subjectUserId, actor.id));
    if ((inbound?.value ?? 0) >= MAX_DIRECT_INBOUND_SHARES_PER_USER) {
      throw refused(
        'validation',
        'inbound_limit',
        `You already have ${MAX_DIRECT_INBOUND_SHARES_PER_USER} projects shared with you, so you cannot take a share on this one.`,
      );
    }
    await tx.delete(schema.projectShare).where(eq(schema.projectShare.id, share.id));
    await tx
      .update(schema.project)
      .set({ userId: target.id })
      .where(eq(schema.project.id, projectId));
    await tx.insert(schema.projectShare).values({
      projectId,
      subjectType: 'person',
      subjectUserId: actor.id,
      permission: 'editor',
      createdByUserId: actor.id,
    });
    // Nothing should change (the old owner is an editor now, the new owner owns),
    // but a group share the new owner never belonged to could matter: be sure.
    await reconcileProject(tx, projectId);
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email ?? null,
    action: 'project.transfer',
    targetType: 'project',
    targetId: projectId,
    metadata: { fromUserId: actor.id, toUserId: target.id, toEmail: target.email },
    ipAddress: actor.ipAddress ?? null,
  });
}
