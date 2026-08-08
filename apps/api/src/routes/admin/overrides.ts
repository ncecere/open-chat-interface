import { and, eq, inArray, schema } from '@oci/db';
import {
  type QuotaOverride,
  USER_ROLES,
  type UserRole,
  upsertQuotaOverrideSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';

export const overrideRoutes = new Hono<AppBindings>();

/** The policies a user's role carries, which is what an override may adjust. */
async function policiesForUser(userId: string) {
  const organizationId = await getDefaultOrganizationId();

  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);

  if (!target) throw notFound('User not found');

  // The column is plain text in the auth schema; narrow it before matching
  // against the typed role on a policy assignment.
  const role = USER_ROLES.find((candidate) => candidate === target.role) as UserRole | undefined;
  if (!role) throw validationFailed('This user has an unrecognized role.');

  const policies = await db
    .select({
      id: schema.quotaPolicy.id,
      name: schema.quotaPolicy.name,
      metric: schema.quotaPolicy.metric,
      limitValue: schema.quotaPolicy.limitValue,
    })
    .from(schema.quotaPolicy)
    .innerJoin(schema.quotaPolicyRole, eq(schema.quotaPolicyRole.policyId, schema.quotaPolicy.id))
    .where(
      and(
        eq(schema.quotaPolicy.organizationId, organizationId),
        eq(schema.quotaPolicyRole.role, role),
      ),
    )
    .orderBy(schema.quotaPolicy.name);

  return { target, policies };
}

/**
 * Every policy applying to a user, with any override folded in.
 *
 * Returning the role's limit alongside the override is what lets the UI show
 * what changed rather than just the resulting number.
 */
overrideRoutes.get('/:userId/quota-overrides', async (c) => {
  const userId = c.req.param('userId');
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

  return c.json({ overrides: entries });
});

overrideRoutes.put('/:userId/quota-overrides', async (c) => {
  const actor = currentUser(c);
  const userId = c.req.param('userId');
  const input = await parseBody(c, upsertQuotaOverrideSchema);
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
    },
  });

  return c.json({ ok: true });
});

overrideRoutes.delete('/:userId/quota-overrides/:policyId', async (c) => {
  const actor = currentUser(c);
  const userId = c.req.param('userId');
  const policyId = c.req.param('policyId');

  const removed = await db
    .delete(schema.quotaPolicyOverride)
    .where(
      and(
        eq(schema.quotaPolicyOverride.userId, userId),
        eq(schema.quotaPolicyOverride.policyId, policyId),
      ),
    )
    .returning({ id: schema.quotaPolicyOverride.id });

  if (removed.length === 0) throw notFound('Override not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.override.clear',
    targetType: 'user',
    targetId: userId,
    metadata: { policyId },
  });

  return c.json({ ok: true });
});

/** How many people hold an override, so the policy list can surface them. */
export async function overrideCountsByPolicy(): Promise<Map<string, number>> {
  const rows = await db
    .select({ policyId: schema.quotaPolicyOverride.policyId })
    .from(schema.quotaPolicyOverride);

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.policyId, (counts.get(row.policyId) ?? 0) + 1);
  return counts;
}
