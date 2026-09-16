import { and, eq, inArray, schema } from '@oci/db';
import type { QuotaPolicy } from '@oci/shared';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';

export async function replaceRoles(policyId: string, roles: QuotaPolicy['roles']): Promise<void> {
  await db.delete(schema.quotaPolicyRole).where(eq(schema.quotaPolicyRole.policyId, policyId));
  if (roles.length === 0) return;

  await db
    .insert(schema.quotaPolicyRole)
    .values(roles.map((role) => ({ policyId, role })))
    .onConflictDoNothing();
}

/**
 * Replaces a policy's model scope. Slugs are validated against the catalog so
 * a typo becomes an error rather than a policy that silently governs nothing.
 */
export async function replaceModels(
  policyId: string,
  organizationId: string,
  modelSlugs: string[],
): Promise<void> {
  await db.delete(schema.quotaPolicyModel).where(eq(schema.quotaPolicyModel.policyId, policyId));
  if (modelSlugs.length === 0) return;

  const unique = [...new Set(modelSlugs)];
  const known = await db
    .select({ slug: schema.model.slug })
    .from(schema.model)
    .where(
      and(eq(schema.model.organizationId, organizationId), inArray(schema.model.slug, unique)),
    );

  const knownSlugs = new Set(known.map((row) => row.slug));
  const unknown = unique.filter((slug) => !knownSlugs.has(slug));
  if (unknown.length > 0) {
    throw validationFailed('Unknown models in the policy scope.', [
      { path: ['modelSlugs'], message: `Not in the catalog: ${unknown.join(', ')}` },
    ]);
  }

  await db
    .insert(schema.quotaPolicyModel)
    .values(unique.map((modelSlug) => ({ policyId, modelSlug })))
    .onConflictDoNothing();
}
