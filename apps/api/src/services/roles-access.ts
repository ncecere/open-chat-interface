import { and, count, eq, schema } from '@oci/db';
import { type RoleAccess, type RolesAccess, USER_ROLES, type UserRole } from '@oci/shared';
import { db } from '../db/index.js';
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

  return { roles };
}
