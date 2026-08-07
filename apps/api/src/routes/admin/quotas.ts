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

  const assignments = await db
    .select({ policyId: schema.quotaPolicyRole.policyId, role: schema.quotaPolicyRole.role })
    .from(schema.quotaPolicyRole)
    .where(
      inArray(
        schema.quotaPolicyRole.policyId,
        rows.map((row) => row.id),
      ),
    );

  const rolesByPolicy = new Map<string, QuotaPolicy['roles']>();
  for (const assignment of assignments) {
    const existing = rolesByPolicy.get(assignment.policyId) ?? [];
    existing.push(assignment.role);
    rolesByPolicy.set(assignment.policyId, existing);
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

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.create',
    targetType: 'quota_policy',
    targetId: created.id,
    metadata: { name: input.name, metric: input.metric, roles: input.roles },
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

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.update',
    targetType: 'quota_policy',
    targetId: id,
    metadata: { name: input.name, metric: input.metric, roles: input.roles },
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
