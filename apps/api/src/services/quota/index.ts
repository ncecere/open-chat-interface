import { and, eq, gt, inArray, isNull, or, schema } from '@oci/db';
import type { UsageSummary, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { getReserveAmounts } from '../lifecycle/settings.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  buildAllowance,
  type EvaluablePolicy,
  type ModelPricing,
  policyCoversModel,
  type WindowTotals,
} from './policy.js';
import { reserveQuota, type UsageReservation } from './reservation.js';
import { windowTotalsIncludingPending } from './usage-totals.js';
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

/**
 * Every enabled policy applied to a role, with model scope and any per-user
 * override resolved.
 *
 * Overrides are applied here rather than at each call site so enforcement and
 * the usage meter can never disagree about what a person's limit actually is.
 */
async function loadPoliciesForRole(role: UserRole, userId?: string): Promise<EvaluablePolicy[]> {
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

  const overrides = userId
    ? await loadOverrides(
        userId,
        rows.map((row) => row.id),
      )
    : new Map();

  return rows.map((row) => ({
    ...row,
    limitValue: overrides.get(row.id) ?? Number(row.limitValue),
    modelSlugs: slugsByPolicy.get(row.id) ?? [],
  }));
}

/**
 * A user's active limit overrides, keyed by policy.
 *
 * Expiry is filtered in the query rather than swept by a job: a job runs on an
 * interval, so between ticks someone would keep an elevated limit their
 * override no longer grants. The read decides; cleanup is only housekeeping.
 */
async function loadOverrides(userId: string, policyIds: string[]): Promise<Map<string, number>> {
  if (policyIds.length === 0) return new Map();

  const rows = await db
    .select({
      policyId: schema.quotaPolicyOverride.policyId,
      limitValue: schema.quotaPolicyOverride.limitValue,
    })
    .from(schema.quotaPolicyOverride)
    .where(
      and(
        eq(schema.quotaPolicyOverride.userId, userId),
        inArray(schema.quotaPolicyOverride.policyId, policyIds),
        or(
          isNull(schema.quotaPolicyOverride.expiresAt),
          gt(schema.quotaPolicyOverride.expiresAt, new Date()),
        ),
      ),
    );

  return new Map(rows.map((row) => [row.policyId, Number(row.limitValue)]));
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
  return windowTotalsIncludingPending(db, userId, start, modelSlugs);
}

/**
 * Reserves quota for a run, throwing when any applied policy is already spent.
 * Unlimited runs also reserve an identity (with no estimated spend/token hold)
 * so completion has the same atomic, retry-safe accounting path.
 */
export async function reserveQuotaForRun(params: {
  userId: string;
  role: UserRole;
  modelSlug: string;
  runId?: string;
}): Promise<UsageReservation> {
  const all = await loadPoliciesForRole(params.role, params.userId);
  // Only policies that govern this model constrain this run; a model in no
  // policy is unlimited.
  const policies = all.filter((policy) => policyCoversModel(policy, params.modelSlug));
  const [pricing, reserve] = await Promise.all([
    modelPricing(params.modelSlug),
    policies.length ? getReserveAmounts() : Promise.resolve({ costMicros: 0, tokens: 0 }),
  ]);

  return reserveQuota({ ...params, policies, pricing, reserve });
}

/** Per-policy consumption for the usage meter in settings. */
export async function getUsageSummary(userId: string, role: UserRole): Promise<UsageSummary> {
  const policies = await loadPoliciesForRole(role, userId);

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

/** Roles that currently have at least one policy applied, for the admin list. */
export async function rolesWithPolicies(roles: readonly UserRole[]): Promise<Set<UserRole>> {
  if (roles.length === 0) return new Set();

  const rows = await db
    .select({ role: schema.quotaPolicyRole.role })
    .from(schema.quotaPolicyRole)
    .where(inArray(schema.quotaPolicyRole.role, [...roles]));

  return new Set(rows.map((row) => row.role));
}
