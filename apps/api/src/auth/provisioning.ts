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
  requireRoleMatch: boolean;
  roleRequiredMessage: string | null;
}

/**
 * Raised when a login matched no role mapping and the provider requires one.
 *
 * Carries the administrator's message so the sign-in page can explain the
 * refusal, rather than showing a generic failure that looks like an outage.
 */
export class SsoRoleRequiredError extends Error {
  constructor(readonly adminMessage: string | null) {
    super(adminMessage?.trim() || 'Your account is not authorised to use this application.');
    this.name = 'SsoRoleRequiredError';
  }
}

export async function loadProviderPolicy(providerId: string): Promise<ProviderPolicy | null> {
  const [row] = await db
    .select({
      jitProvisioning: schema.ssoProvider.jitProvisioning,
      allowedDomains: schema.ssoProvider.allowedDomains,
      defaultRole: schema.ssoProvider.defaultRole,
      claimRoleMappings: schema.ssoProvider.claimRoleMappings,
      requireRoleMatch: schema.ssoProvider.requireRoleMatch,
      roleRequiredMessage: schema.ssoProvider.roleRequiredMessage,
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
    requireRoleMatch: row.requireRoleMatch,
    roleRequiredMessage: row.roleRequiredMessage,
  };
}

export function isDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? allowedDomains.includes(domain) : false;
}

/** Most privileged first, so a tie between mappings resolves predictably. */
// Every assignable role must appear here, or a mapping to it never matches.
const ROLE_PRECEDENCE: UserRole[] = ['admin', 'auditor', 'user', 'restricted'];

/**
 * Reads a claim, following dots into nested objects.
 *
 * SAML assertions and some OIDC providers nest group membership rather than
 * exposing it at the top level, so `attributes.groups` has to be reachable.
 */
function claimValue(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];

  let current: unknown = claims;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Whether a claim carries the expected value.
 *
 * Group membership arrives as an array far more often than as a scalar, and
 * either shape has to match. Comparison is case-insensitive because directory
 * services are inconsistent about the casing of group names, and a mapping
 * that silently fails to match is worse than one that matches too readily.
 */
function claimMatches(value: unknown, expected: string): boolean {
  const wanted = expected.trim().toLowerCase();
  if (!wanted) return false;

  if (Array.isArray(value)) {
    return value.some((entry) => String(entry).trim().toLowerCase() === wanted);
  }
  if (value === undefined || value === null) return false;
  return String(value).trim().toLowerCase() === wanted;
}

/**
 * Resolves a role from IdP claims or group membership.
 *
 * Every mapping is evaluated and the most privileged match wins, rather than
 * the first one listed. Someone in both a staff group and an administrators
 * group should not get a different role depending on the order an
 * administrator happened to add the rows.
 */
export function resolveRoleFromClaims(
  claims: Record<string, unknown> | undefined,
  mappings: ClaimRoleMapping[],
  defaultRole: UserRole,
): UserRole {
  return matchRoleFromClaims(claims, mappings) ?? defaultRole;
}

/**
 * The role the claims actually match, or null when none do.
 *
 * Separate from `resolveRoleFromClaims` because "matched nothing" and "matched
 * a rule that happens to grant the default role" are the same answer once a
 * default has been substituted, and refusing a login has to tell them apart.
 */
export function matchRoleFromClaims(
  claims: Record<string, unknown> | undefined,
  mappings: ClaimRoleMapping[],
): UserRole | null {
  if (!claims || mappings.length === 0) return null;

  const matched = mappings.filter(
    (mapping) =>
      USER_ROLES.includes(mapping.role) &&
      claimMatches(claimValue(claims, mapping.claim), mapping.value),
  );

  if (matched.length === 0) return null;

  for (const role of ROLE_PRECEDENCE) {
    if (matched.some((mapping) => mapping.role === role)) return role;
  }

  return null;
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

  const matched = matchRoleFromClaims(params.claims, policy.claimRoleMappings);

  if (policy.requireRoleMatch && matched === null) {
    // Refused rather than admitted with the default role. Without this, every
    // account the identity provider will authenticate receives access, which
    // for an institution-wide provider is everyone.
    //
    // The plugin creates the session before calling this hook and sets the
    // cookie afterwards, so throwing keeps the browser unauthenticated but
    // leaves the row behind. Clearing it means a refused attempt cannot be
    // resumed and does not accumulate.
    await db.delete(schema.session).where(eq(schema.session.userId, params.userId));

    logger.warn(
      { userId: params.userId, providerId: params.providerId },
      'SSO login refused: no role mapping matched',
    );
    throw new SsoRoleRequiredError(policy.roleRequiredMessage);
  }

  const role = matched ?? policy.defaultRole;

  await db.update(schema.user).set({ role }).where(eq(schema.user.id, params.userId));

  logger.info(
    { userId: params.userId, providerId: params.providerId, role },
    'SSO user provisioned',
  );
}
