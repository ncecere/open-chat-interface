import { and, eq, gte, inArray, or, schema, sql } from '@oci/db';
import type { UsageSummary, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { getReserveAmounts } from '../lifecycle/settings.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  buildAllowance,
  calculateCostMicros,
  type EvaluablePolicy,
  type ModelPricing,
  policyCoversModel,
  type WindowTotals,
} from './policy.js';
import { RESERVATION_TTL_MS, reserveQuota, type UsageReservation } from './reservation.js';
import { resolveWindow } from './windows.js';

export {
  allowanceSeverity,
  calculateCostMicros,
  describeLimit,
  describeWindow,
  formatMicros,
  policyCoversModel,
} from './policy.js';
export {
  RESERVATION_TTL_MS,
  releaseReservation,
  reserveQuota,
  settleReservation,
  sweepAbandonedReservations,
  type UsageReservation,
} from './reservation.js';
export { resolveWindow } from './windows.js';

/** Every enabled policy applied to a role, with its model scope resolved. */
async function loadPoliciesForRole(role: UserRole): Promise<EvaluablePolicy[]> {
  const organizationId = await getDefaultOrganizationId();

  const rows = await db
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

  if (rows.length === 0) return [];

  const scopes = await db
    .select({
      policyId: schema.quotaPolicyModel.policyId,
      modelSlug: schema.quotaPolicyModel.modelSlug,
    })
    .from(schema.quotaPolicyModel)
    .where(
      inArray(
        schema.quotaPolicyModel.policyId,
        rows.map((row) => row.id),
      ),
    );

  const slugsByPolicy = new Map<string, string[]>();
  for (const scope of scopes) {
    const existing = slugsByPolicy.get(scope.policyId) ?? [];
    existing.push(scope.modelSlug);
    slugsByPolicy.set(scope.policyId, existing);
  }

  return rows.map((row) => ({ ...row, modelSlugs: slugsByPolicy.get(row.id) ?? [] }));
}

/**
 * Sums a user's consumption from per-event rows. A daily rollup cannot answer
 * a rolling or non-UTC calendar window, so events are the source of truth.
 * In-flight reservations count so the meter reflects work already committed.
 */
async function windowTotals(
  userId: string,
  start: Date,
  modelSlugs: string[] = [],
): Promise<WindowTotals> {
  const liveCutoff = new Date(Date.now() - RESERVATION_TTL_MS);

  const conditions = [
    eq(schema.usageEvent.userId, userId),
    gte(schema.usageEvent.occurredAt, start),
    // Abandoned reservations stop counting once they age past the TTL.
    or(eq(schema.usageEvent.pending, false), gte(schema.usageEvent.occurredAt, liveCutoff)),
  ];

  if (modelSlugs.length > 0) {
    conditions.push(inArray(schema.usageEvent.modelSlug, modelSlugs));
  }

  const [totals] = await db
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn} + ${schema.usageEvent.tokensOut} + ${schema.usageEvent.reservedTokens}), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros} + ${schema.usageEvent.reservedCostMicros}), 0)::bigint`,
    })
    .from(schema.usageEvent)
    .where(and(...conditions));

  // postgres returns bigint sums as strings; normalize before any arithmetic.
  return {
    messages: Number(totals?.messages ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    costMicros: Number(totals?.costMicros ?? 0),
  };
}

/**
 * Reserves quota for a run, throwing when any applied policy is already spent.
 * Returns null when no policy applies, so unlimited instances write no
 * reservation row at all.
 */
export async function reserveQuotaForRun(params: {
  userId: string;
  role: UserRole;
  modelSlug: string;
}): Promise<UsageReservation | null> {
  const all = await loadPoliciesForRole(params.role);
  // Only policies that govern this model constrain this run; a model in no
  // policy is unlimited.
  const policies = all.filter((policy) => policyCoversModel(policy, params.modelSlug));
  if (policies.length === 0) return null;

  const [pricing, reserve] = await Promise.all([
    modelPricing(params.modelSlug),
    getReserveAmounts(),
  ]);

  return reserveQuota({ ...params, policies, pricing, reserve });
}

/** Per-policy consumption for the usage meter in settings. */
export async function getUsageSummary(userId: string, role: UserRole): Promise<UsageSummary> {
  const policies = await loadPoliciesForRole(role);

  const allowances = await Promise.all(
    policies.map(async (policy) => {
      const { start, resetsAt } = resolveWindow(policy);
      const totals = await windowTotals(userId, start, policy.modelSlugs);
      return buildAllowance(policy, totals, resetsAt);
    }),
  );

  const recent = await windowTotals(userId, new Date(Date.now() - 24 * 60 * 60 * 1000));

  return { allowances, recent };
}

/** Current catalog prices for a model, or nulls when it is unpriced. */
async function modelPricing(modelSlug: string): Promise<ModelPricing> {
  const organizationId = await getDefaultOrganizationId();

  const [pricing] = await db
    .select({
      inputPriceMicros: schema.model.inputPriceMicros,
      outputPriceMicros: schema.model.outputPriceMicros,
    })
    .from(schema.model)
    .where(and(eq(schema.model.organizationId, organizationId), eq(schema.model.slug, modelSlug)))
    .limit(1);

  return {
    inputPriceMicros: pricing?.inputPriceMicros ?? null,
    outputPriceMicros: pricing?.outputPriceMicros ?? null,
  };
}

export interface RecordUsageInput {
  userId: string;
  modelSlug: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Records usage for a run that was never reserved, which happens only when no
 * quota policy applies. Prices are snapshotted so later catalog edits never
 * rewrite historical spend.
 */
export async function recordUsage(params: RecordUsageInput): Promise<void> {
  const organizationId = await getDefaultOrganizationId();
  const snapshot = await modelPricing(params.modelSlug);
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
    pending: false,
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
