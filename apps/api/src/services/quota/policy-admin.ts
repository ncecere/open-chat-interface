import { and, eq, schema } from '@oci/db';
import type { UpsertQuotaPolicyInput } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { diffSettings } from '../settings-diff.js';
import { replaceModels, replaceRoles, validateModelScope } from './policy-assignments.js';
import { loadPolicies } from './policy-queries.js';
import { isValidTimezone } from './windows.js';

type Actor = { id: string; email: string };

/** Calendar windows ignore windowHours; rolling windows ignore the timezone. */
function normalizeWindow(input: { windowKind: string; windowHours?: number | null }) {
  return input.windowKind === 'rolling' ? (input.windowHours ?? 24) : null;
}

/** Concurrent name claims can race the friendly precheck; preserve its domain error. */
function rethrowPolicyWriteError(error: unknown): never {
  let cause = error;
  while (cause && typeof cause === 'object') {
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === 'quota_policy_org_name_unique'
    ) {
      throw conflict('A policy with that name already exists');
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

export async function createQuotaPolicy(actor: Actor, input: UpsertQuotaPolicyInput) {
  const organizationId = await getDefaultOrganizationId();

  if (!isValidTimezone(input.timezone)) {
    throw validationFailed('Unknown timezone.', [
      { path: ['timezone'], message: 'Use an IANA timezone such as America/New_York.' },
    ]);
  }

  const created = await db
    .transaction(async (tx) => {
      const [existing] = await tx
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

      const modelSlugs = await validateModelScope(tx, organizationId, input.modelSlugs);
      const [policy] = await tx
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

      if (!policy) throw validationFailed('The policy could not be created.');
      await replaceRoles(tx, policy.id, input.roles);
      await replaceModels(tx, policy.id, modelSlugs);
      return { ...policy, modelSlugs };
    })
    .catch(rethrowPolicyWriteError);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.create',
    targetType: 'quota_policy',
    targetId: created.id,
    // The limit, window, zone and state too, as its update and delete entries
    // record them (#374): the entry said a budget was created, not what it
    // allowed.
    metadata: policyValues({
      ...input,
      windowHours: normalizeWindow(input),
      modelSlugs: created.modelSlugs,
    }),
  });

  return { id: created.id };
}

/** A budget's values as its audit entries record them, roles and models sorted. */
function policyValues(policy: {
  name: string;
  description?: string | null;
  metric: string;
  limitValue: number | string;
  windowKind: string;
  windowHours: number | null;
  timezone: string;
  enabled: boolean;
  roles: readonly string[];
  modelSlugs: readonly string[];
}) {
  return {
    name: policy.name,
    description: policy.description ?? null,
    metric: policy.metric,
    limitValue: Number(policy.limitValue),
    windowKind: policy.windowKind,
    windowHours: policy.windowHours,
    timezone: policy.timezone,
    enabled: policy.enabled,
    roles: [...policy.roles].sort(),
    modelSlugs: [...policy.modelSlugs].sort(),
  };
}

export async function updateQuotaPolicy(actor: Actor, id: string, input: UpsertQuotaPolicyInput) {
  const organizationId = await getDefaultOrganizationId();

  if (!isValidTimezone(input.timezone)) {
    throw validationFailed('Unknown timezone.', [
      { path: ['timezone'], message: 'Use an IANA timezone such as America/New_York.' },
    ]);
  }

  // As it was, so the audit entry can say what each value was (#221). Read
  // before the edit's transaction, as the delete below does.
  const [previous] = await loadPolicies(organizationId, [id]);
  if (!previous) throw notFound('Policy not found');

  const next = policyValues({
    ...input,
    description: input.description ?? null,
    windowHours: normalizeWindow(input),
  });
  await db
    .transaction(async (tx) => {
      // Serialize edits before reading/replacing either assignment set.
      const [existing] = await tx
        .select({ id: schema.quotaPolicy.id })
        .from(schema.quotaPolicy)
        .where(
          and(eq(schema.quotaPolicy.id, id), eq(schema.quotaPolicy.organizationId, organizationId)),
        )
        .limit(1)
        .for('update');
      if (!existing) throw notFound('Policy not found');

      const [nameClash] = await tx
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

      const modelSlugs = await validateModelScope(tx, organizationId, input.modelSlugs);
      await tx
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

      await replaceRoles(tx, id, input.roles);
      await replaceModels(tx, id, modelSlugs);
    })
    .catch(rethrowPolicyWriteError);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.update',
    targetType: 'quota_policy',
    targetId: id,
    // The budget as saved, and each value that changed as it was and as it
    // became; the limit and window used not to be recorded at all (#221).
    metadata: { ...next, changes: diffSettings(policyValues(previous), next) },
  });

  return { id };
}

export async function deleteQuotaPolicy(actor: Actor, id: string) {
  const organizationId = await getDefaultOrganizationId();

  // The whole policy, with its roles, models and override count, so the
  // audit entry says what was removed, not only its name (#148).
  const [existing] = await loadPolicies(organizationId, [id]);
  if (!existing) throw notFound('Policy not found');

  await db.delete(schema.quotaPolicy).where(eq(schema.quotaPolicy.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.policy.delete',
    targetType: 'quota_policy',
    targetId: id,
    metadata: {
      name: existing.name,
      description: existing.description,
      metric: existing.metric,
      limitValue: existing.limitValue,
      windowKind: existing.windowKind,
      windowHours: existing.windowHours,
      timezone: existing.timezone,
      enabled: existing.enabled,
      roles: existing.roles,
      modelSlugs: existing.modelSlugs,
      overrideCount: existing.overrideCount,
    },
  });

  return { ok: true };
}
