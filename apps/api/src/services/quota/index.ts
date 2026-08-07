import { and, eq, gte, inArray, schema, sql } from '@oci/db';
import type { UsageSummary, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { quotaExceeded } from '../../lib/errors.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  buildAllowance,
  calculateCostMicros,
  type EvaluablePolicy,
  limitMessage,
  usedForMetric,
  type WindowTotals,
} from './policy.js';
import { resolveWindow } from './windows.js';

export {
  calculateCostMicros,
  describeLimit,
  describeWindow,
  formatMicros,
} from './policy.js';
export { resolveWindow } from './windows.js';

/** Every enabled policy applied to a role, ordered so messages are reported first. */
async function loadPoliciesForRole(role: UserRole): Promise<EvaluablePolicy[]> {
  const organizationId = await getDefaultOrganizationId();

  return db
    .select({
      id: schema.quotaPolicy.id,
      name: schema.quotaPolicy.name,
      metric: schema.quotaPolicy.metric,
      limitValue: schema.quotaPolicy.limitValue,
      windowKind: schema.quotaPolicy.windowKind,
      windowHours: schema.quotaPolicy.windowHours,
      timezone: schema.quotaPolicy.timezone,
    })
    .from(schema.quotaPolicy)
    .innerJoin(schema.quotaPolicyRole, eq(schema.quotaPolicyRole.policyId, schema.quotaPolicy.id))
    .where(
      and(
        eq(schema.quotaPolicy.organizationId, organizationId),
        eq(schema.quotaPolicy.enabled, true),
        eq(schema.quotaPolicyRole.role, role),
      ),
    )
    .orderBy(schema.quotaPolicy.name);
}

/**
 * Sums a user's consumption from per-event rows. A daily rollup cannot answer
 * a rolling or non-UTC calendar window, so events are the source of truth.
 */
async function windowTotals(userId: string, start: Date): Promise<WindowTotals> {
  const [totals] = await db
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn} + ${schema.usageEvent.tokensOut}), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros}), 0)::bigint`,
    })
    .from(schema.usageEvent)
    .where(and(eq(schema.usageEvent.userId, userId), gte(schema.usageEvent.occurredAt, start)));

  // postgres returns bigint sums as strings; normalize before any arithmetic.
  return {
    messages: Number(totals?.messages ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    costMicros: Number(totals?.costMicros ?? 0),
  };
}

/** Throws when any policy applied to the caller's role is already spent. */
export async function checkQuota(userId: string, role: UserRole): Promise<void> {
  const policies = await loadPoliciesForRole(role);

  for (const policy of policies) {
    const { start } = resolveWindow(policy);
    const totals = await windowTotals(userId, start);

    if (usedForMetric(policy.metric, totals) >= policy.limitValue) {
      throw quotaExceeded(limitMessage(policy));
    }
  }
}

/** Per-policy consumption for the usage meter in settings. */
export async function getUsageSummary(userId: string, role: UserRole): Promise<UsageSummary> {
  const policies = await loadPoliciesForRole(role);

  const allowances = await Promise.all(
    policies.map(async (policy) => {
      const { start, resetsAt } = resolveWindow(policy);
      return buildAllowance(policy, await windowTotals(userId, start), resetsAt);
    }),
  );

  const recent = await windowTotals(userId, new Date(Date.now() - 24 * 60 * 60 * 1000));

  return { allowances, recent };
}

export interface RecordUsageInput {
  userId: string;
  modelSlug: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Writes one usage event plus the daily rollup used by admin analytics. Prices
 * are snapshotted so later catalog edits never rewrite historical spend.
 */
export async function recordUsage(params: RecordUsageInput): Promise<void> {
  const organizationId = await getDefaultOrganizationId();

  const [pricing] = await db
    .select({
      inputPriceMicros: schema.model.inputPriceMicros,
      outputPriceMicros: schema.model.outputPriceMicros,
    })
    .from(schema.model)
    .where(
      and(eq(schema.model.organizationId, organizationId), eq(schema.model.slug, params.modelSlug)),
    )
    .limit(1);

  const snapshot = {
    inputPriceMicros: pricing?.inputPriceMicros ?? null,
    outputPriceMicros: pricing?.outputPriceMicros ?? null,
  };
  const costMicros = calculateCostMicros(snapshot, params.tokensIn, params.tokensOut);
  const occurredAt = new Date();

  await db.insert(schema.usageEvent).values({
    organizationId,
    userId: params.userId,
    modelSlug: params.modelSlug,
    occurredAt,
    messageCount: 1,
    tokensIn: params.tokensIn,
    tokensOut: params.tokensOut,
    costMicros,
    inputPriceMicros: snapshot.inputPriceMicros,
    outputPriceMicros: snapshot.outputPriceMicros,
  });

  await db
    .insert(schema.usageRecord)
    .values({
      organizationId,
      userId: params.userId,
      modelSlug: params.modelSlug,
      day: occurredAt.toISOString().slice(0, 10),
      messageCount: 1,
      tokensIn: params.tokensIn,
      tokensOut: params.tokensOut,
      costMicros,
    })
    .onConflictDoUpdate({
      target: [schema.usageRecord.userId, schema.usageRecord.modelSlug, schema.usageRecord.day],
      set: {
        messageCount: sql`${schema.usageRecord.messageCount} + 1`,
        tokensIn: sql`${schema.usageRecord.tokensIn} + ${params.tokensIn}`,
        tokensOut: sql`${schema.usageRecord.tokensOut} + ${params.tokensOut}`,
        costMicros: sql`${schema.usageRecord.costMicros} + ${costMicros}`,
      },
    });
}

/** Roles that currently have at least one policy applied, for the admin list. */
export async function rolesWithPolicies(roles: readonly UserRole[]): Promise<Set<UserRole>> {
  if (roles.length === 0) return new Set();

  const rows = await db
    .select({ role: schema.quotaPolicyRole.role })
    .from(schema.quotaPolicyRole)
    .where(inArray(schema.quotaPolicyRole.role, [...roles]));

  return new Set(rows.map((row) => row.role));
}
