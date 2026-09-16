import { and, type Database, eq, inArray, schema } from '@oci/db';
import type { QuotaPolicy } from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';

export type PolicyTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function replaceRoles(
  tx: PolicyTransaction,
  policyId: string,
  roles: QuotaPolicy['roles'],
): Promise<void> {
  await tx.delete(schema.quotaPolicyRole).where(eq(schema.quotaPolicyRole.policyId, policyId));
  const unique = [...new Set(roles)];
  if (unique.length === 0) return;

  await tx.insert(schema.quotaPolicyRole).values(unique.map((role) => ({ policyId, role })));
}

/** Validate the entire scope before mutating the policy or any assignments. */
export async function validateModelScope(
  tx: PolicyTransaction,
  organizationId: string,
  modelSlugs: string[],
): Promise<string[]> {
  const unique = [...new Set(modelSlugs)];
  if (unique.length === 0) return unique;

  const known = await tx
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

  return unique;
}

/** Replace a previously validated scope in the same transaction as the policy. */
export async function replaceModels(
  tx: PolicyTransaction,
  policyId: string,
  modelSlugs: string[],
): Promise<void> {
  await tx.delete(schema.quotaPolicyModel).where(eq(schema.quotaPolicyModel.policyId, policyId));
  const unique = [...new Set(modelSlugs)];
  if (unique.length === 0) return;

  await tx
    .insert(schema.quotaPolicyModel)
    .values(unique.map((modelSlug) => ({ policyId, modelSlug })));
}
