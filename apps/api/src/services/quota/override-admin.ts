import { and, eq, inArray, schema } from '@oci/db';
import type { QuotaOverride, UpsertQuotaOverrideInput } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { policiesForUser } from './policy-queries.js';

type Actor = { id: string; email: string };

export async function listUserOverrides(userId: string) {
  const { policies } = await policiesForUser(userId);

  const overrides =
    policies.length === 0
      ? []
      : await db
          .select()
          .from(schema.quotaPolicyOverride)
          .where(
            and(
              eq(schema.quotaPolicyOverride.userId, userId),
              inArray(
                schema.quotaPolicyOverride.policyId,
                policies.map((policy) => policy.id),
              ),
            ),
          );

  const byPolicy = new Map(overrides.map((row) => [row.policyId, row]));
  const now = Date.now();

  const entries: QuotaOverride[] = policies.map((policy) => {
    const override = byPolicy.get(policy.id);
    const roleLimit = Number(policy.limitValue);

    return {
      policyId: policy.id,
      policyName: policy.name,
      metric: policy.metric,
      roleLimitValue: roleLimit,
      limitValue: override ? Number(override.limitValue) : roleLimit,
      expiresAt: override?.expiresAt?.toISOString() ?? null,
      reason: override?.reason ?? null,
      // An expired row still exists until cleanup runs, but it no longer
      // applies, so it must not read as active.
      active: Boolean(override && (!override.expiresAt || override.expiresAt.getTime() > now)),
      createdAt: override?.createdAt.toISOString() ?? '',
    };
  });

  return { overrides: entries };
}

/** An override as its audit entries record it. */
function overrideValues(row: {
  limitValue: number | string;
  expiresAt: Date | null;
  reason: string | null;
}) {
  return {
    limitValue: Number(row.limitValue),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    reason: row.reason,
  };
}

export async function setUserOverride(
  actor: Actor,
  userId: string,
  input: UpsertQuotaOverrideInput,
) {
  const { policies } = await policiesForUser(userId);

  // An override adjusts a limit the role already carries. Allowing an
  // unassigned policy would make this a back door for granting individuals
  // policies their role was never given.
  const policy = policies.find((entry) => entry.id === input.policyId);
  if (!policy) {
    throw validationFailed('That policy does not apply to this user.', [
      {
        path: ['policyId'],
        message: 'Only policies applied to the user\u2019s role can be adjusted.',
      },
    ]);
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw validationFailed('The expiry must be in the future.', [
      { path: ['expiresAt'], message: 'Choose a date later than now.' },
    ]);
  }

  // The override this replaces, if any, so the entry says what it was (#221).
  const [previous] = await db
    .select({
      limitValue: schema.quotaPolicyOverride.limitValue,
      expiresAt: schema.quotaPolicyOverride.expiresAt,
      reason: schema.quotaPolicyOverride.reason,
    })
    .from(schema.quotaPolicyOverride)
    .where(
      and(
        eq(schema.quotaPolicyOverride.policyId, input.policyId),
        eq(schema.quotaPolicyOverride.userId, userId),
      ),
    )
    .limit(1);

  await db
    .insert(schema.quotaPolicyOverride)
    .values({
      policyId: input.policyId,
      userId,
      limitValue: input.limitValue,
      expiresAt,
      reason: input.reason ?? null,
      createdByUserId: actor.id,
    })
    .onConflictDoUpdate({
      target: [schema.quotaPolicyOverride.policyId, schema.quotaPolicyOverride.userId],
      set: {
        limitValue: input.limitValue,
        expiresAt,
        reason: input.reason ?? null,
        createdByUserId: actor.id,
        updatedAt: new Date(),
      },
    });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.override.set',
    targetType: 'user',
    targetId: userId,
    metadata: {
      policyId: input.policyId,
      policyName: policy.name,
      roleLimitValue: Number(policy.limitValue),
      limitValue: input.limitValue,
      expiresAt: expiresAt?.toISOString() ?? null,
      reason: input.reason ?? null,
      previous: previous ? overrideValues(previous) : null,
    },
  });

  return { ok: true };
}

export async function clearUserOverride(actor: Actor, userId: string, policyId: string) {
  const removed = await db
    .delete(schema.quotaPolicyOverride)
    .where(
      and(
        eq(schema.quotaPolicyOverride.userId, userId),
        eq(schema.quotaPolicyOverride.policyId, policyId),
      ),
    )
    .returning({
      limitValue: schema.quotaPolicyOverride.limitValue,
      expiresAt: schema.quotaPolicyOverride.expiresAt,
      reason: schema.quotaPolicyOverride.reason,
    });

  const [cleared] = removed;
  if (!cleared) throw notFound('Override not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.override.clear',
    targetType: 'user',
    targetId: userId,
    // What was removed, as other deletes record (#148, #221).
    metadata: { policyId, previous: overrideValues(cleared) },
  });

  return { ok: true };
}
