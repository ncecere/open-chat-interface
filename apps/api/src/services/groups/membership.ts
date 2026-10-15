import { and, asc, count, eq, ilike, inArray, or, schema, sql } from '@oci/db';
import {
  type AddGroupMembersResult,
  GROUP_ERROR_REASONS,
  type GroupMember,
  type GroupMemberRoleName,
  type GroupMembersPage,
  MAX_GROUPS_PER_PERSON,
  MAX_MANAGERS_PER_GROUP,
  MAX_MEMBERS_PER_GROUP,
  type ManagedGroup,
  type MyGroup,
  type UserGroup,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { containsPattern } from '../../lib/like.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { onGroupMembersRemoved } from './access-changes.js';

/** Where a lookup runs: the pool, or the transaction that must see its own writes. */
export type GroupExecutor = Pick<typeof db, 'select'>;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who is making the change, for the audit entry. */
export interface GroupActor {
  id: string;
  email: string;
}

const NO_GROUP = 'Group not found';
const formatted = (value: number) => value.toLocaleString('en-US');

/**
 * The ids of every group a person belongs to, as member or manager.
 *
 * One indexed read (`group_member_user_idx`), never cached: a removed member
 * loses what the group granted on their next request, and project access is
 * computed from this per request. Callers that need it twice in one request
 * should keep the array themselves rather than ask for a cache here.
 */
export async function groupIdsForUser(
  userId: string,
  executor: GroupExecutor = db,
): Promise<string[]> {
  const rows = await executor
    .select({ groupId: schema.groupMember.groupId })
    .from(schema.groupMember)
    .where(eq(schema.groupMember.userId, userId));
  return rows.map((row) => row.groupId);
}

/** True when the person is a member or manager of the group right now. */
export async function isGroupMember(
  groupId: string,
  userId: string,
  executor: GroupExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ groupId: schema.groupMember.groupId })
    .from(schema.groupMember)
    .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Decides whether a signed-in person may manage one group's members, and how
 * to refuse when not, without telling anyone what exists:
 *
 * - they manage it: allowed;
 * - they are in it, or manage some other group: 403 (the same answer for a
 *   group that does not exist, so a manager cannot probe ids);
 * - they manage nothing and are not in it: 404, as if the routes did not exist.
 *
 * Administrators use the admin routes; an administrator who manages no group
 * is an outsider here.
 */
export async function requireGroupManager(
  userId: string,
  groupId: string,
  executor: GroupExecutor = db,
): Promise<void> {
  const mine = await executor
    .select({ groupId: schema.groupMember.groupId, role: schema.groupMember.role })
    .from(schema.groupMember)
    .where(eq(schema.groupMember.userId, userId));
  const here = mine.find((row) => row.groupId === groupId);
  if (here?.role === 'manager') return;
  if (here || mine.some((row) => row.role === 'manager')) {
    throw forbidden('You do not manage this group.');
  }
  throw notFound(NO_GROUP);
}

/** The groups a person is in, for the share dialog. */
export async function listMyGroups(userId: string): Promise<MyGroup[]> {
  const rows = await db
    .select({
      id: schema.group.id,
      name: schema.group.name,
      role: schema.groupMember.role,
    })
    .from(schema.groupMember)
    .innerJoin(schema.group, eq(schema.groupMember.groupId, schema.group.id))
    .where(eq(schema.groupMember.userId, userId))
    .orderBy(asc(sql`lower(${schema.group.name})`));
  return rows;
}

/** The groups a person manages, with counts. Empty for everyone else. */
export async function listManagedGroups(userId: string): Promise<ManagedGroup[]> {
  const rows = await db
    .select({
      id: schema.group.id,
      name: schema.group.name,
      description: schema.group.description,
    })
    .from(schema.groupMember)
    .innerJoin(schema.group, eq(schema.groupMember.groupId, schema.group.id))
    .where(and(eq(schema.groupMember.userId, userId), eq(schema.groupMember.role, 'manager')))
    .orderBy(asc(sql`lower(${schema.group.name})`));
  if (rows.length === 0) return [];
  const counts = await memberCounts(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    memberCount: counts.get(row.id)?.members ?? 0,
    managerCount: counts.get(row.id)?.managers ?? 0,
    memberLimit: MAX_MEMBERS_PER_GROUP,
  }));
}

/** How many groups a person manages (`GET /api/me` shows the Settings tab when it is above zero). */
export async function countManagedGroups(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.groupMember)
    .where(and(eq(schema.groupMember.userId, userId), eq(schema.groupMember.role, 'manager')));
  return row?.value ?? 0;
}

/** The groups of one person, for the administrator's user detail. */
export async function listUserGroups(userId: string): Promise<UserGroup[]> {
  const [target] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  if (!target) throw notFound('User not found');
  return db
    .select({ id: schema.group.id, name: schema.group.name, role: schema.groupMember.role })
    .from(schema.groupMember)
    .innerJoin(schema.group, eq(schema.groupMember.groupId, schema.group.id))
    .where(eq(schema.groupMember.userId, userId))
    .orderBy(asc(sql`lower(${schema.group.name})`));
}

/** Members and managers of each group, in one read. */
export async function memberCounts(
  groupIds: string[],
): Promise<Map<string, { members: number; managers: number }>> {
  const result = new Map<string, { members: number; managers: number }>();
  if (groupIds.length === 0) return result;
  const rows = await db
    .select({
      groupId: schema.groupMember.groupId,
      members: count(),
      managers: sql<number>`count(*) filter (where ${schema.groupMember.role} = 'manager')`.mapWith(
        Number,
      ),
    })
    .from(schema.groupMember)
    .where(inArray(schema.groupMember.groupId, groupIds))
    .groupBy(schema.groupMember.groupId);
  for (const row of rows) result.set(row.groupId, { members: row.members, managers: row.managers });
  return result;
}

/** One page of a group's members, by name. */
export async function listGroupMembers(
  groupId: string,
  query: { search?: string; page: number; pageSize: number },
): Promise<GroupMembersPage> {
  const [found] = await db
    .select({ id: schema.group.id })
    .from(schema.group)
    .where(eq(schema.group.id, groupId))
    .limit(1);
  if (!found) throw notFound(NO_GROUP);

  const filter = and(
    eq(schema.groupMember.groupId, groupId),
    query.search
      ? or(
          ilike(schema.user.email, containsPattern(query.search)),
          ilike(schema.user.name, containsPattern(query.search)),
        )
      : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.groupMember.role,
        addedAt: schema.groupMember.createdAt,
      })
      .from(schema.groupMember)
      .innerJoin(schema.user, eq(schema.groupMember.userId, schema.user.id))
      .where(filter)
      .orderBy(asc(sql`lower(${schema.user.name})`), asc(schema.user.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ value: count() })
      .from(schema.groupMember)
      .innerJoin(schema.user, eq(schema.groupMember.userId, schema.user.id))
      .where(filter),
  ]);
  return {
    members: rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() })),
    page: query.page,
    pageSize: query.pageSize,
    total: total?.value ?? 0,
  };
}

/** Locks the group row, the parent every membership count is taken under. */
async function lockGroup(tx: Transaction, groupId: string) {
  const [row] = await tx
    .select({ id: schema.group.id, name: schema.group.name })
    .from(schema.group)
    .where(eq(schema.group.id, groupId))
    .for('update');
  if (!row) throw notFound(NO_GROUP);
  return row;
}

/**
 * Locks accounts in id order, `NO KEY UPDATE`: two requests adding the same
 * person to different groups queue here (so the per-person count is exact)
 * without blocking foreign-key checks that other rows make against the account.
 */
async function lockUsers(tx: Transaction, userIds: string[]) {
  if (userIds.length === 0) return;
  await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(inArray(schema.user.id, userIds))
    .orderBy(asc(schema.user.id))
    .for('no key update');
}

/**
 * Adds people by email address.
 *
 * Everything is decided inside one transaction with the group row locked: the
 * member and manager caps are counted after the lock, so two requests racing
 * for the last place cannot both succeed, and a request that would break a
 * cap changes nothing. An address already in the group is left as it is (a
 * manager asked for as a member stays a manager; change roles with
 * `changeMemberRole`). With `asManager` set, the person making the request is
 * checked to manage the group inside the same transaction.
 */
export async function addGroupMembers(params: {
  actor: GroupActor;
  groupId: string;
  emails: string[];
  role: GroupMemberRoleName;
  /** Present for a manager acting on their own group: re-checked under the lock. */
  asManager?: boolean;
}): Promise<AddGroupMembersResult> {
  const { actor, groupId, emails, role } = params;
  const organizationId = await getDefaultOrganizationId();

  const outcome = await db.transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (params.asManager) await requireGroupManager(actor.id, groupId, tx);

    const found = await tx
      .select({ id: schema.user.id, email: schema.user.email })
      .from(schema.user)
      .where(
        and(
          eq(schema.user.organizationId, organizationId),
          inArray(sql`lower(${schema.user.email})`, emails),
        ),
      )
      .orderBy(asc(schema.user.id));
    const byEmail = new Map(found.map((row) => [row.email.toLowerCase(), row]));
    const unknown = emails.filter((email) => !byEmail.has(email));

    await lockUsers(
      tx,
      found.map((row) => row.id),
    );

    const existing = found.length
      ? await tx
          .select({ userId: schema.groupMember.userId })
          .from(schema.groupMember)
          .where(
            and(
              eq(schema.groupMember.groupId, groupId),
              inArray(
                schema.groupMember.userId,
                found.map((row) => row.id),
              ),
            ),
          )
      : [];
    const already = new Set(existing.map((row) => row.userId));
    const toAdd = found.filter((row) => !already.has(row.id));
    const alreadyMembers = emails.filter((email) => {
      const row = byEmail.get(email);
      return row && already.has(row.id);
    });

    const [totals] = await tx
      .select({
        members: count(),
        managers:
          sql<number>`count(*) filter (where ${schema.groupMember.role} = 'manager')`.mapWith(
            Number,
          ),
      })
      .from(schema.groupMember)
      .where(eq(schema.groupMember.groupId, groupId));
    const members = totals?.members ?? 0;
    const managers = totals?.managers ?? 0;

    if (members + toAdd.length > MAX_MEMBERS_PER_GROUP) {
      throw conflict(
        `A group can have at most ${formatted(MAX_MEMBERS_PER_GROUP)} members. This one has ${formatted(members)}, so ${formatted(
          Math.max(0, MAX_MEMBERS_PER_GROUP - members),
        )} more can be added.`,
        { reason: GROUP_ERROR_REASONS.MEMBER_LIMIT, limit: MAX_MEMBERS_PER_GROUP },
      );
    }
    if (role === 'manager' && managers + toAdd.length > MAX_MANAGERS_PER_GROUP) {
      throw conflict(
        `A group can have at most ${MAX_MANAGERS_PER_GROUP} managers. This one has ${managers}.`,
        { reason: GROUP_ERROR_REASONS.MANAGER_LIMIT, limit: MAX_MANAGERS_PER_GROUP },
      );
    }

    if (toAdd.length > 0) {
      const crowded = await tx
        .select({ userId: schema.groupMember.userId })
        .from(schema.groupMember)
        .where(
          inArray(
            schema.groupMember.userId,
            toAdd.map((row) => row.id),
          ),
        )
        .groupBy(schema.groupMember.userId)
        .having(sql`count(*) >= ${MAX_GROUPS_PER_PERSON}`);
      if (crowded.length > 0) {
        const names = new Set(crowded.map((row) => row.userId));
        const who = toAdd.filter((row) => names.has(row.id)).map((row) => row.email.toLowerCase());
        throw conflict(
          `A person can be in at most ${MAX_GROUPS_PER_PERSON} groups. Already in ${MAX_GROUPS_PER_PERSON}: ${who.join(', ')}. Nobody was added.`,
          {
            reason: GROUP_ERROR_REASONS.PERSON_GROUP_LIMIT,
            limit: MAX_GROUPS_PER_PERSON,
            emails: who,
          },
        );
      }
      await tx.insert(schema.groupMember).values(
        toAdd.map((row) => ({
          groupId,
          userId: row.id,
          role,
          addedByUserId: actor.id,
        })),
      );
    }

    return {
      group,
      added: toAdd.map((row) => ({ userId: row.id, email: row.email, role })),
      alreadyMembers,
      unknown,
      memberCount: members + toAdd.length,
    };
  });

  if (outcome.added.length > 0) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'group.member.add',
      targetType: 'group',
      targetId: groupId,
      metadata: {
        groupName: outcome.group.name,
        role,
        viaManager: Boolean(params.asManager),
        userIds: outcome.added.map((row) => row.userId),
        emails: outcome.added.map((row) => row.email),
      },
    });
  }
  return {
    added: outcome.added,
    alreadyMembers: outcome.alreadyMembers,
    unknown: outcome.unknown,
    memberCount: outcome.memberCount,
  };
}

/** Appoints or removes a manager (administrators). */
export async function changeMemberRole(params: {
  actor: GroupActor;
  groupId: string;
  userId: string;
  role: GroupMemberRoleName;
}): Promise<GroupMember> {
  const { actor, groupId, userId, role } = params;
  const result = await db.transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    const [row] = await tx
      .select({
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.groupMember.role,
        addedAt: schema.groupMember.createdAt,
      })
      .from(schema.groupMember)
      .innerJoin(schema.user, eq(schema.groupMember.userId, schema.user.id))
      .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)));
    if (!row) throw notFound('That person is not in this group.');
    if (row.role === role) return { group, member: row, before: role };

    if (role === 'manager') {
      const [managers] = await tx
        .select({ value: count() })
        .from(schema.groupMember)
        .where(
          and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.role, 'manager')),
        );
      if ((managers?.value ?? 0) >= MAX_MANAGERS_PER_GROUP) {
        throw conflict(
          `A group can have at most ${MAX_MANAGERS_PER_GROUP} managers. This one has ${managers?.value}.`,
          { reason: GROUP_ERROR_REASONS.MANAGER_LIMIT, limit: MAX_MANAGERS_PER_GROUP },
        );
      }
    }
    await tx
      .update(schema.groupMember)
      .set({ role })
      .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)));
    return { group, member: { ...row, role }, before: row.role };
  });

  if (result.before !== role) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'group.member.role',
      targetType: 'group',
      targetId: groupId,
      metadata: {
        groupName: result.group.name,
        userId,
        email: result.member.email,
        before: result.before,
        after: role,
      },
    });
  }
  return { ...result.member, addedAt: result.member.addedAt.toISOString() };
}

/**
 * Removes one person from a group, at once: the models and budgets the group
 * gave them stop applying on their next request. An administrator may remove
 * anyone. A manager (`asManager`) may remove a member, or themselves, but not
 * another manager.
 */
export async function removeGroupMember(params: {
  actor: GroupActor;
  groupId: string;
  userId: string;
  asManager?: boolean;
}): Promise<void> {
  const { actor, groupId, userId } = params;
  const result = await db.transaction(async (tx) => {
    const group = await lockGroup(tx, groupId);
    if (params.asManager) await requireGroupManager(actor.id, groupId, tx);
    await lockUsers(tx, [userId]);
    const [row] = await tx
      .select({
        role: schema.groupMember.role,
        email: schema.user.email,
      })
      .from(schema.groupMember)
      .innerJoin(schema.user, eq(schema.groupMember.userId, schema.user.id))
      .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)));
    if (!row) throw notFound('That person is not in this group.');
    if (params.asManager && row.role === 'manager' && userId !== actor.id) {
      throw forbidden('Only an administrator can remove a manager.');
    }
    await tx
      .delete(schema.groupMember)
      .where(and(eq(schema.groupMember.groupId, groupId), eq(schema.groupMember.userId, userId)));
    await onGroupMembersRemoved(tx, groupId, [userId]);
    return { group, email: row.email, role: row.role };
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'group.member.remove',
    targetType: 'group',
    targetId: groupId,
    metadata: {
      groupName: result.group.name,
      viaManager: Boolean(params.asManager),
      role: result.role,
      userIds: [userId],
      emails: [result.email],
    },
  });
}
