import { and, asc, count, eq, ilike, inArray, schema, sql } from '@oci/db';
import {
  type AdminGroup,
  type AdminGroupDetail,
  type AdminGroupsPage,
  type CreateGroupInput,
  type DeleteGroupResult,
  GROUP_ERROR_REASONS,
  type GroupGrants,
  MAX_GROUPS,
  type UpdateGroupInput,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { containsPattern } from '../../lib/like.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { diffSettings } from '../settings-diff.js';
import { countGroupSharedProjects, onGroupDeleting } from './access-changes.js';
import { type GroupActor, memberCounts } from './membership.js';

const NO_GROUP = 'Group not found';

/** A concurrent create or rename that took the name between the check and the write. */
function nameTaken(name: string) {
  return conflict(`A group named “${name}” already exists.`, {
    reason: GROUP_ERROR_REASONS.NAME_TAKEN,
  });
}

function isNameClash(error: unknown): boolean {
  let cause = error;
  while (cause && typeof cause === 'object') {
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === 'group_name_unique'
    ) {
      return true;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

async function grantCounts(
  groupIds: string[],
): Promise<Map<string, { policies: number; models: number }>> {
  const result = new Map<string, { policies: number; models: number }>();
  if (groupIds.length === 0) return result;
  const [policies, models] = await Promise.all([
    db
      .select({ groupId: schema.quotaPolicyGroup.groupId, value: count() })
      .from(schema.quotaPolicyGroup)
      .where(inArray(schema.quotaPolicyGroup.groupId, groupIds))
      .groupBy(schema.quotaPolicyGroup.groupId),
    db
      .select({ groupId: schema.modelGroupAccess.groupId, value: count() })
      .from(schema.modelGroupAccess)
      .where(inArray(schema.modelGroupAccess.groupId, groupIds))
      .groupBy(schema.modelGroupAccess.groupId),
  ]);
  for (const id of groupIds) result.set(id, { policies: 0, models: 0 });
  for (const row of policies) result.get(row.groupId)!.policies = row.value;
  for (const row of models) result.get(row.groupId)!.models = row.value;
  return result;
}

type GroupRow = typeof schema.group.$inferSelect;

async function summarise(rows: GroupRow[]): Promise<AdminGroup[]> {
  const ids = rows.map((row) => row.id);
  const [members, grants] = await Promise.all([memberCounts(ids), grantCounts(ids)]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: members.get(row.id)!.members,
    managerCount: members.get(row.id)!.managers,
    policyCount: grants.get(row.id)!.policies,
    modelCount: grants.get(row.id)!.models,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listGroups(query: {
  search?: string;
  page: number;
  pageSize: number;
}): Promise<AdminGroupsPage> {
  const organizationId = await getDefaultOrganizationId();
  const filter = and(
    eq(schema.group.organizationId, organizationId),
    query.search ? ilike(schema.group.name, containsPattern(query.search)) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(schema.group)
      .where(filter)
      .orderBy(asc(sql`lower(${schema.group.name})`), asc(schema.group.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(schema.group).where(filter),
  ]);
  return {
    groups: await summarise(rows),
    page: query.page,
    pageSize: query.pageSize,
    total: total!.value,
    limit: MAX_GROUPS,
  };
}

async function loadGroup(id: string): Promise<GroupRow> {
  const [row] = await db.select().from(schema.group).where(eq(schema.group.id, id)).limit(1);
  if (!row) throw notFound(NO_GROUP);
  return row;
}

/** What the group grants, named for the checklists. */
export async function getGroupGrants(id: string): Promise<GroupGrants> {
  await loadGroup(id);
  const [policies, models] = await Promise.all([
    db
      .select({
        id: schema.quotaPolicy.id,
        name: schema.quotaPolicy.name,
        enabled: schema.quotaPolicy.enabled,
      })
      .from(schema.quotaPolicyGroup)
      .innerJoin(schema.quotaPolicy, eq(schema.quotaPolicyGroup.policyId, schema.quotaPolicy.id))
      .where(eq(schema.quotaPolicyGroup.groupId, id))
      .orderBy(asc(sql`lower(${schema.quotaPolicy.name})`)),
    db
      .select({
        id: schema.model.id,
        slug: schema.model.slug,
        displayName: schema.model.displayName,
        enabled: schema.model.enabled,
      })
      .from(schema.modelGroupAccess)
      .innerJoin(schema.model, eq(schema.modelGroupAccess.modelId, schema.model.id))
      .where(eq(schema.modelGroupAccess.groupId, id))
      .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName)),
  ]);
  return { policies, models };
}

export async function getGroupDetail(id: string): Promise<AdminGroupDetail> {
  const row = await loadGroup(id);
  const [[summary], grants, creator, sharedProjectCount] = await Promise.all([
    summarise([row]),
    getGroupGrants(id),
    row.createdByUserId
      ? db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, row.createdByUserId))
          .limit(1)
      : Promise.resolve([]),
    countGroupSharedProjects(db, id),
  ]);
  return { ...summary!, grants, createdByName: creator[0]?.name ?? null, sharedProjectCount };
}

export async function createGroup(actor: GroupActor, input: CreateGroupInput): Promise<AdminGroup> {
  const organizationId = await getDefaultOrganizationId();
  const created = await db
    .transaction(async (tx) => {
      // The parent row for the count: two creates at the cap queue here.
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, organizationId))
        .for('no key update');
      const [existing] = await tx
        .select({ id: schema.group.id })
        .from(schema.group)
        .where(
          and(
            eq(schema.group.organizationId, organizationId),
            sql`lower(${schema.group.name}) = lower(${input.name})`,
          ),
        )
        .limit(1);
      if (existing) throw nameTaken(input.name);
      const [total] = await tx
        .select({ value: count() })
        .from(schema.group)
        .where(eq(schema.group.organizationId, organizationId));
      if (total!.value >= MAX_GROUPS) {
        throw conflict(
          `An instance can have at most ${MAX_GROUPS} groups. Delete one that is no longer used first.`,
          { reason: GROUP_ERROR_REASONS.GROUP_LIMIT, limit: MAX_GROUPS },
        );
      }
      const [row] = await tx
        .insert(schema.group)
        .values({
          organizationId,
          name: input.name,
          description: input.description || null,
          createdByUserId: actor.id,
        })
        .returning();
      return row!;
    })
    .catch((error: unknown) => {
      if (isNameClash(error)) throw nameTaken(input.name);
      throw error;
    });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'group.create',
    targetType: 'group',
    targetId: created.id,
    metadata: { name: created.name, description: created.description },
  });
  const [summary] = await summarise([created]);
  return summary!;
}

export async function updateGroup(
  actor: GroupActor,
  id: string,
  input: UpdateGroupInput,
): Promise<AdminGroup> {
  const { before, after } = await db
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.group)
        .where(eq(schema.group.id, id))
        .for('update');
      if (!current) throw notFound(NO_GROUP);
      const patch: Partial<Pick<GroupRow, 'name' | 'description'>> = {};
      if (input.name !== undefined) patch.name = input.name;
      // An empty description clears it, as null does.
      if (input.description !== undefined) patch.description = input.description || null;

      if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase()) {
        const [clash] = await tx
          .select({ id: schema.group.id })
          .from(schema.group)
          .where(
            and(
              eq(schema.group.organizationId, current.organizationId),
              sql`lower(${schema.group.name}) = lower(${patch.name})`,
            ),
          )
          .limit(1);
        if (clash) throw nameTaken(patch.name);
      }
      const [row] = await tx
        .update(schema.group)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.group.id, id))
        .returning();
      return { before: current, after: row! };
    })
    .catch((error: unknown) => {
      if (isNameClash(error) && input.name) throw nameTaken(input.name);
      throw error;
    });

  const changes = diffSettings(
    { name: before.name, description: before.description },
    { name: after.name, description: after.description },
  );
  if (changes.length > 0) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'group.update',
      targetType: 'group',
      targetId: id,
      metadata: { name: after.name, changes },
    });
  }
  const [summary] = await summarise([after]);
  return summary!;
}

export async function deleteGroup(actor: GroupActor, id: string): Promise<DeleteGroupResult> {
  const result = await db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(schema.group)
      .where(eq(schema.group.id, id))
      .for('update');
    if (!group) throw notFound(NO_GROUP);
    const members = await tx
      .select({ userId: schema.groupMember.userId })
      .from(schema.groupMember)
      .where(eq(schema.groupMember.groupId, id))
      .orderBy(asc(schema.groupMember.userId));
    const [[policies], [models]] = await Promise.all([
      tx
        .select({ value: count() })
        .from(schema.quotaPolicyGroup)
        .where(eq(schema.quotaPolicyGroup.groupId, id)),
      tx
        .select({ value: count() })
        .from(schema.modelGroupAccess)
        .where(eq(schema.modelGroupAccess.groupId, id)),
    ]);
    const sharedProjects = await countGroupSharedProjects(tx, id);
    const afterDelete = await onGroupDeleting(
      tx,
      id,
      members.map((row) => row.userId),
    );
    // Members, budget and model grants (and project shares) cascade.
    await tx.delete(schema.group).where(eq(schema.group.id, id));
    await afterDelete?.();
    return {
      group,
      removed: {
        members: members.length,
        policies: policies!.value,
        models: models!.value,
        sharedProjects,
      },
    };
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'group.delete',
    targetType: 'group',
    targetId: id,
    metadata: { name: result.group.name, removed: result.removed },
  });
  return { ok: true, removed: result.removed };
}
