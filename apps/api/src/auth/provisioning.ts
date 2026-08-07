import { eq, schema } from '@oci/db';
import type { ClaimRoleMapping, UserRole } from '@oci/shared';
import { USER_ROLES } from '@oci/shared';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';

interface ProviderPolicy {
  jitProvisioning: boolean;
  allowedDomains: string[];
  defaultRole: UserRole;
  claimRoleMappings: ClaimRoleMapping[];
}

export async function loadProviderPolicy(providerId: string): Promise<ProviderPolicy | null> {
  const [row] = await db
    .select({
      jitProvisioning: schema.ssoProvider.jitProvisioning,
      allowedDomains: schema.ssoProvider.allowedDomains,
      defaultRole: schema.ssoProvider.defaultRole,
      claimRoleMappings: schema.ssoProvider.claimRoleMappings,
      enabled: schema.ssoProvider.enabled,
    })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .limit(1);

  if (!row?.enabled) return null;

  return {
    jitProvisioning: row.jitProvisioning,
    allowedDomains: row.allowedDomains,
    defaultRole: row.defaultRole as UserRole,
    claimRoleMappings: row.claimRoleMappings,
  };
}

export function isDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? allowedDomains.includes(domain) : false;
}

/**
 * Resolves a role from IdP claims. The first matching mapping wins; otherwise
 * the provider's configured default role is used.
 */
export function resolveRoleFromClaims(
  claims: Record<string, unknown> | undefined,
  mappings: ClaimRoleMapping[],
  defaultRole: UserRole,
): UserRole {
  if (!claims || mappings.length === 0) return defaultRole;

  for (const mapping of mappings) {
    const claimValue = claims[mapping.claim];
    const matches = Array.isArray(claimValue)
      ? claimValue.some((entry) => String(entry) === mapping.value)
      : String(claimValue ?? '') === mapping.value;

    if (matches && USER_ROLES.includes(mapping.role)) {
      return mapping.role;
    }
  }

  return defaultRole;
}

/**
 * Called by the SSO plugin after a successful assertion. Applies the provider's
 * domain allowlist and claim-to-role mapping to the freshly linked user.
 */
export async function applySsoProvisioning(params: {
  userId: string;
  email: string;
  providerId: string;
  claims: Record<string, unknown> | undefined;
}): Promise<void> {
  const policy = await loadProviderPolicy(params.providerId);
  if (!policy) {
    logger.warn({ providerId: params.providerId }, 'SSO login for unknown or disabled provider');
    return;
  }

  if (!isDomainAllowed(params.email, policy.allowedDomains)) {
    throw new Error(`Email domain is not permitted for provider ${params.providerId}`);
  }

  const role = resolveRoleFromClaims(params.claims, policy.claimRoleMappings, policy.defaultRole);

  await db.update(schema.user).set({ role }).where(eq(schema.user.id, params.userId));

  logger.info(
    { userId: params.userId, providerId: params.providerId, role },
    'SSO user provisioned',
  );
}
