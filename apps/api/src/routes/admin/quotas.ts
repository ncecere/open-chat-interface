import { and, eq, inArray, schema } from '@oci/db';
import { type QuotaPolicy, upsertQuotaPolicySchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { isValidTimezone } from '../../services/quota/windows.js';
import { overrideCountsByPolicy } from './overrides.js';

export const quotaRoutes = new Hono<AppBindings>();

async function loadPolicies(organizationId: string, ids?: string[]): Promise<QuotaPolicy[]> {
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

  const [assignments, scopes, overrideCounts] = await Promise.all([
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
  ]);

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Calendar windows ignore windowHours; rolling windows ignore the timezone. */
function normalizeWindow(input: { windowKind: string; windowHours?: number | null }) {
  return input.windowKind === 'rolling' ? (input.windowHours ?? 24) : null;
}

async function replaceRoles(policyId: string, roles: QuotaPolicy['roles']): Promise<void> {
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
async function replaceModels(
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

quotaRoutes.get('/', async (c) => {
  const organizationId = await getDefaultOrganizationId();
  return c.json({ policies: await loadPolicies(organizationId) });
});

quotaRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertQuotaPolicySchema);
  const organizationId = await getDefaultOrganizationId();

  if (!isValidTimezone(input.timezone)) {
    throw validationFailed('Unknown timezone.', [
      { path: ['timezone'], message: 'Use an IANA timezone such as America/New_York.' },
    ]);
  }

  const [existing] = await db
    .select({ id: schema.quotaPolicy.id })
    .from(schema.quotaPolicy)
    .where(
      and(
        eq(schema.quotaPolicy.organizationId, organizationId),
        eq(schema.quotaPolicy.name, input.name),
      ),
    )
    .limit(1);
  if (existing) throw conflict('A policy with that name already exists');

  const [created] = await db
    .insert(schema.quotaPolicy)
    .values({
      organizationId,
      name: input.name,
      description: input.description ?? null,
      metric: input.metric,
      limitValue: input.limitValue,
      windowKind: input.windowKind,
      windowHours: normalizeWindow(input),
      timezone: input.timezone,
      enabled: input.enabled,
    })
    .returning({ id: schema.quotaPolicy.id });

  if (!created) throw validationFailed('The policy could not be created.');
  await replaceRoles(created.id, input.roles);
  await replaceModels(created.id, organizationId, input.modelSlugs);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.create',
    targetType: 'quota_policy',
    targetId: created.id,
    metadata: {
      name: input.name,
      metric: input.metric,
      roles: input.roles,
      modelSlugs: input.modelSlugs,
    },
  });

  return c.json({ id: created.id }, 201);
});

quotaRoutes.put('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const input = await parseBody(c, upsertQuotaPolicySchema);
  const organizationId = await getDefaultOrganizationId();

  if (!isValidTimezone(input.timezone)) {
    throw validationFailed('Unknown timezone.', [
      { path: ['timezone'], message: 'Use an IANA timezone such as America/New_York.' },
    ]);
  }

  const [existing] = await db
    .select({ id: schema.quotaPolicy.id })
    .from(schema.quotaPolicy)
    .where(
      and(eq(schema.quotaPolicy.id, id), eq(schema.quotaPolicy.organizationId, organizationId)),
    )
    .limit(1);
  if (!existing) throw notFound('Policy not found');

  const [nameClash] = await db
    .select({ id: schema.quotaPolicy.id })
    .from(schema.quotaPolicy)
    .where(
      and(
        eq(schema.quotaPolicy.organizationId, organizationId),
        eq(schema.quotaPolicy.name, input.name),
      ),
    )
    .limit(1);
  if (nameClash && nameClash.id !== id) {
    throw conflict('A policy with that name already exists');
  }

  await db
    .update(schema.quotaPolicy)
    .set({
      name: input.name,
      description: input.description ?? null,
      metric: input.metric,
      limitValue: input.limitValue,
      windowKind: input.windowKind,
      windowHours: normalizeWindow(input),
      timezone: input.timezone,
      enabled: input.enabled,
    })
    .where(eq(schema.quotaPolicy.id, id));

  await replaceRoles(id, input.roles);
  await replaceModels(id, organizationId, input.modelSlugs);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.update',
    targetType: 'quota_policy',
    targetId: id,
    metadata: {
      name: input.name,
      metric: input.metric,
      roles: input.roles,
      modelSlugs: input.modelSlugs,
    },
  });

  return c.json({ id });
});

quotaRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const organizationId = await getDefaultOrganizationId();

  const [existing] = await db
    .select({ id: schema.quotaPolicy.id, name: schema.quotaPolicy.name })
    .from(schema.quotaPolicy)
    .where(
      and(eq(schema.quotaPolicy.id, id), eq(schema.quotaPolicy.organizationId, organizationId)),
    )
    .limit(1);
  if (!existing) throw notFound('Policy not found');

  await db.delete(schema.quotaPolicy).where(eq(schema.quotaPolicy.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.delete',
    targetType: 'quota_policy',
    targetId: id,
    metadata: { name: existing.name },
  });

  return c.json({ ok: true });
});
