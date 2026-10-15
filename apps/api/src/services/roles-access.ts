import { and, asc, count, eq, inArray, schema, sql } from '@oci/db';
import {
  type RoleAccess,
  type RolesAccess,
  type RolesAccessGroup,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { memberCounts } from './groups/membership.js';
import { getConfigSources, getRateLimitSettings } from './lifecycle/settings.js';
import { getDefaultOrganizationId } from './organization.js';
import { combineFeatures, resolveRoleFeatures } from './role-features.js';
import { getSetting } from './settings.js';
import { listStoragePolicies } from './storage/quota.js';
import { registeredTools } from './tools/catalog.js';
import { describeRoleTools } from './tools/role-tools.js';

/**
 * Rules enforced in code for a role, independent of any setting. Kept beside
 * the summary so the page states them instead of leaving admins to discover
 * them; the enforcing check is the admin method guard. Feature limits (such as
 * the restricted role's defaults) are role settings, not fixed rules.
 */
const FIXED_RULES: Record<UserRole, string[]> = {
  admin: ['Full administrative access.'],
  auditor: ['Can view administration but cannot change it.'],
  user: [],
  restricted: [],
};

/**
 * Everything that shapes one role, gathered for a single page. Each value comes
 * from the same function enforcement uses, so the summary cannot disagree with
 * what a person in that role experiences.
 */
export async function getRolesAccess(): Promise<RolesAccess> {
  const organizationId = await getDefaultOrganizationId();
  const [
    rateLimits,
    sources,
    storage,
    features,
    search,
    storedRoleFeatures,
    storedRoleTools,
    tools,
    users,
    budgets,
    models,
  ] = await Promise.all([
    getRateLimitSettings(),
    getConfigSources(),
    listStoragePolicies(),
    getSetting('features'),
    getSetting('search'),
    getSetting('roleFeatures'),
    getSetting('roleTools'),
    registeredTools(),
    db
      .select({ role: schema.user.role, value: count() })
      .from(schema.user)
      .where(eq(schema.user.organizationId, organizationId))
      .groupBy(schema.user.role),
    db
      .select({
        role: schema.quotaPolicyRole.role,
        id: schema.quotaPolicy.id,
        name: schema.quotaPolicy.name,
        metric: schema.quotaPolicy.metric,
        limitValue: schema.quotaPolicy.limitValue,
        windowKind: schema.quotaPolicy.windowKind,
        windowHours: schema.quotaPolicy.windowHours,
        enabled: schema.quotaPolicy.enabled,
      })
      .from(schema.quotaPolicyRole)
      .innerJoin(schema.quotaPolicy, eq(schema.quotaPolicyRole.policyId, schema.quotaPolicy.id))
      .where(eq(schema.quotaPolicy.organizationId, organizationId))
      .orderBy(schema.quotaPolicy.name),
    // Only models a person could actually pick: enabled, on an enabled provider.
    db
      .select({ visibleToRoles: schema.model.visibleToRoles })
      .from(schema.model)
      .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
      .where(
        and(
          eq(schema.model.organizationId, organizationId),
          eq(schema.model.enabled, true),
          eq(schema.provider.enabled, true),
        ),
      ),
  ]);

  const roles: RoleAccess[] = USER_ROLES.map((role) => {
    const own = resolveRoleFeatures(role, storedRoleFeatures);
    const { reasoningEfforts: _efforts, ...effective } = combineFeatures(features, search, own);
    return {
      role,
      userCount: users.find((row) => row.role === role)?.value ?? 0,
      rateLimits: rateLimits.roles[role],
      rateLimitSources: sources.rateLimits.roles[role],
      storage: storage.find((policy) => policy.role === role) ?? null,
      budgets: budgets
        .filter((budget) => budget.role === role)
        .map(({ role: _role, ...budget }) => budget),
      models: {
        visible: models.filter((model) => model.visibleToRoles.includes(role)).length,
        available: models.length,
      },
      features: effective,
      roleFeatures: own,
      tools: describeRoleTools(role, storedRoleTools, tools),
      fixedRules: FIXED_RULES[role],
    };
  });

  return { roles, groups: await getGroupsAccess(organizationId) };
}

/**
 * The Groups section of the page (v0.14): what each group adds on top of a role,
 * read-only. Groups only add; per-role counts above stay role-only on purpose.
 */
async function getGroupsAccess(organizationId: string): Promise<RolesAccessGroup[]> {
  const groups = await db
    .select({ id: schema.group.id, name: schema.group.name })
    .from(schema.group)
    .where(eq(schema.group.organizationId, organizationId))
    .orderBy(asc(sql`lower(${schema.group.name})`), asc(schema.group.id));
  if (groups.length === 0) return [];
  const ids = groups.map((group) => group.id);
  const [counts, budgets, models] = await Promise.all([
    memberCounts(ids),
    db
      .select({
        groupId: schema.quotaPolicyGroup.groupId,
        id: schema.quotaPolicy.id,
        name: schema.quotaPolicy.name,
        enabled: schema.quotaPolicy.enabled,
      })
      .from(schema.quotaPolicyGroup)
      .innerJoin(schema.quotaPolicy, eq(schema.quotaPolicyGroup.policyId, schema.quotaPolicy.id))
      .where(inArray(schema.quotaPolicyGroup.groupId, ids))
      .orderBy(asc(sql`lower(${schema.quotaPolicy.name})`)),
    db
      .select({
        groupId: schema.modelGroupAccess.groupId,
        id: schema.model.id,
        displayName: schema.model.displayName,
        enabled: schema.model.enabled,
      })
      .from(schema.modelGroupAccess)
      .innerJoin(schema.model, eq(schema.modelGroupAccess.modelId, schema.model.id))
      .where(inArray(schema.modelGroupAccess.groupId, ids))
      .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName)),
  ]);
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    memberCount: counts.get(group.id)?.members ?? 0,
    managerCount: counts.get(group.id)?.managers ?? 0,
    budgets: budgets
      .filter((row) => row.groupId === group.id)
      .map(({ groupId: _groupId, ...budget }) => budget),
    models: models
      .filter((row) => row.groupId === group.id)
      .map(({ groupId: _groupId, ...model }) => model),
  }));
}
