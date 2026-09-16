import { and, eq, schema } from '@oci/db';
import type { UpsertQuotaPolicyInput } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { replaceModels, replaceRoles } from './policy-assignments.js';
import { isValidTimezone } from './windows.js';

type Actor = { id: string; email: string };

/** Calendar windows ignore windowHours; rolling windows ignore the timezone. */
function normalizeWindow(input: { windowKind: string; windowHours?: number | null }) {
  return input.windowKind === 'rolling' ? (input.windowHours ?? 24) : null;
}

export async function createQuotaPolicy(actor: Actor, input: UpsertQuotaPolicyInput) {
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

  return { id: created.id };
}

export async function updateQuotaPolicy(actor: Actor, id: string, input: UpsertQuotaPolicyInput) {
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

  return { id };
}

export async function deleteQuotaPolicy(actor: Actor, id: string) {
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

  return { ok: true };
}
