import { eq, schema, sql } from '@oci/db';
import type { BudgetSources, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';

type SQL = ReturnType<typeof sql.raw>;

/**
 * A condition on `quota_policy` that holds for the budgets one person is held
 * to: those attached to their role OR to any group they are in (v0.14, #394).
 *
 * Written as two `EXISTS` rather than joins so a budget that reaches the person
 * both ways (or through two groups) is one row, never two: the same budget is
 * enforced once, not summed with itself. Everything after this (a model scope,
 * a per-person override, checking each budget on its own against the person's
 * own usage, most restrictive wins) treats a group budget exactly as a role
 * budget. Nothing is added up, and no group budget can loosen a role budget.
 *
 * Read per call, never cached: leaving a group ends its budget on the next
 * request.
 */
export function budgetAppliesTo(role: UserRole, userId: string | undefined): SQL {
  const viaRole = sql`exists (
    select 1 from ${schema.quotaPolicyRole}
    where ${schema.quotaPolicyRole.policyId} = ${schema.quotaPolicy.id}
      and ${schema.quotaPolicyRole.role} = ${role})`;
  if (userId === undefined) return viaRole;
  return sql`(${viaRole} or exists (
    select 1 from ${schema.quotaPolicyGroup}
    inner join ${schema.groupMember}
      on ${schema.groupMember.groupId} = ${schema.quotaPolicyGroup.groupId}
    where ${schema.quotaPolicyGroup.policyId} = ${schema.quotaPolicy.id}
      and ${schema.groupMember.userId} = ${userId}))`;
}

/**
 * How each budget reaches a person, for the administrator's view of their
 * limits: by policy id, `role` and/or each group that carries it.
 */
export async function budgetSources(userId: string, role: UserRole): Promise<BudgetSources> {
  const [viaRole, viaGroups] = await Promise.all([
    db
      .select({ policyId: schema.quotaPolicyRole.policyId })
      .from(schema.quotaPolicyRole)
      .where(eq(schema.quotaPolicyRole.role, role)),
    db
      .select({
        policyId: schema.quotaPolicyGroup.policyId,
        groupId: schema.group.id,
        groupName: schema.group.name,
      })
      .from(schema.quotaPolicyGroup)
      .innerJoin(
        schema.groupMember,
        eq(schema.groupMember.groupId, schema.quotaPolicyGroup.groupId),
      )
      .innerJoin(schema.group, eq(schema.group.id, schema.quotaPolicyGroup.groupId))
      .where(eq(schema.groupMember.userId, userId))
      .orderBy(schema.group.name),
  ]);
  const sources: BudgetSources = {};
  for (const row of viaRole) (sources[row.policyId] ??= []).push({ kind: 'role' });
  for (const row of viaGroups) {
    (sources[row.policyId] ??= []).push({
      kind: 'group',
      groupId: row.groupId,
      groupName: row.groupName,
    });
  }
  return sources;
}
