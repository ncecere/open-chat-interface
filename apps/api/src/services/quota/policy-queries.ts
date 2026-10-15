import { and, eq, inArray, schema } from '@oci/db';
import { type QuotaPolicy, USER_ROLES, type UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { getDefaultOrganizationId } from '../organization.js';
import { budgetAppliesTo } from './applicability.js';

export async function loadPolicies(organizationId: string, ids?: string[]): Promise<QuotaPolicy[]> {
  const rows = await db
    .select()
    .from(schema.quotaPolicy)
    .where(
      ids
        ? and(
            eq(schema.quotaPolicy.organizationId, organizationId),
            inArray(schema.quotaPolicy.id, ids),
          )
        : eq(schema.quotaPolicy.organizationId, organizationId),
    )
    .orderBy(schema.quotaPolicy.name);

  if (rows.length === 0) return [];

  const policyIds = rows.map((row) => row.id);

  const [assignments, scopes, overrideCounts, groupRows] = await Promise.all([
    db
      .select({ policyId: schema.quotaPolicyRole.policyId, role: schema.quotaPolicyRole.role })
      .from(schema.quotaPolicyRole)
      .where(inArray(schema.quotaPolicyRole.policyId, policyIds)),
    db
      .select({
        policyId: schema.quotaPolicyModel.policyId,
        modelSlug: schema.quotaPolicyModel.modelSlug,
      })
      .from(schema.quotaPolicyModel)
      .where(inArray(schema.quotaPolicyModel.policyId, policyIds)),
    overrideCountsByPolicy(),
    // The groups the policy is attached to, as read-only chips: grants are
    // written from the group, never through the budget form.
    db
      .select({
        policyId: schema.quotaPolicyGroup.policyId,
        id: schema.group.id,
        name: schema.group.name,
      })
      .from(schema.quotaPolicyGroup)
      .innerJoin(schema.group, eq(schema.quotaPolicyGroup.groupId, schema.group.id))
      .where(inArray(schema.quotaPolicyGroup.policyId, policyIds))
      .orderBy(schema.group.name),
  ]);

  const groupsByPolicy = new Map<string, { id: string; name: string }[]>();
  for (const row of groupRows) {
    const existing = groupsByPolicy.get(row.policyId) ?? [];
    existing.push({ id: row.id, name: row.name });
    groupsByPolicy.set(row.policyId, existing);
  }

  const rolesByPolicy = new Map<string, QuotaPolicy['roles']>();
  for (const assignment of assignments) {
    const existing = rolesByPolicy.get(assignment.policyId) ?? [];
    existing.push(assignment.role);
    rolesByPolicy.set(assignment.policyId, existing);
  }

  const modelsByPolicy = new Map<string, string[]>();
  for (const scope of scopes) {
    const existing = modelsByPolicy.get(scope.policyId) ?? [];
    existing.push(scope.modelSlug);
    modelsByPolicy.set(scope.policyId, existing);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    metric: row.metric,
    limitValue: Number(row.limitValue),
    windowKind: row.windowKind,
    windowHours: row.windowHours,
    timezone: row.timezone,
    enabled: row.enabled,
    roles: rolesByPolicy.get(row.id) ?? [],
    modelSlugs: (modelsByPolicy.get(row.id) ?? []).sort(),
    // Surfaced so an override is discoverable from the policy as well as from
    // the person it was granted to.
    overrideCount: overrideCounts.get(row.id) ?? 0,
    groups: groupsByPolicy.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * The policies that apply to a user, which is what an override may adjust: the
 * ones their role carries and the ones a group they are in carries (v0.14).
 */
export async function policiesForUser(userId: string) {
  const organizationId = await getDefaultOrganizationId();

  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);

  if (!target) throw notFound('User not found');

  // The column is plain text in the auth schema; narrow it before matching
  // against the typed role on a policy assignment.
  const role = USER_ROLES.find((candidate) => candidate === target.role) as UserRole | undefined;
  if (!role) throw validationFailed('This user has an unrecognized role.');

  const policies = await db
    .select({
      id: schema.quotaPolicy.id,
      name: schema.quotaPolicy.name,
      metric: schema.quotaPolicy.metric,
      limitValue: schema.quotaPolicy.limitValue,
    })
    .from(schema.quotaPolicy)
    .where(
      and(eq(schema.quotaPolicy.organizationId, organizationId), budgetAppliesTo(role, userId)),
    )
    .orderBy(schema.quotaPolicy.name);

  return { target, policies };
}

/** How many people hold an override, so the policy list can surface them. */
export async function overrideCountsByPolicy(): Promise<Map<string, number>> {
  const rows = await db
    .select({ policyId: schema.quotaPolicyOverride.policyId })
    .from(schema.quotaPolicyOverride);

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.policyId, (counts.get(row.policyId) ?? 0) + 1);
  return counts;
}
