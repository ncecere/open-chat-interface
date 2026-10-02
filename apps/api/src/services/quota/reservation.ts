import { schema, sql } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, quotaExceeded } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  type EvaluablePolicy,
  limitMessage,
  type ModelPricing,
  usedForMetric,
  type WindowTotals,
} from './policy.js';
import { lockUsageOwner } from './settlement.js';
import { windowTotalsIncludingPending } from './usage-totals.js';
import { resolveWindow } from './windows.js';

export { RESERVATION_TTL_MS } from './reservation-state.js';
export { releaseReservation, settleReservation } from './settlement.js';
export { sweepAbandonedReservations } from './sweep.js';

export interface UsageReservation {
  id: string;
  userId: string;
  modelSlug: string;
  /** Informational snapshot; settlement reads the durable event's prices. */
  pricing: ModelPricing;
}

/** Estimates are clamped to remaining allowance, then replaced by reported usage. */
export interface ReserveAmounts {
  costMicros: number;
  tokens: number;
}

function reservedAmounts(
  policies: EvaluablePolicy[],
  totals: Map<string, WindowTotals>,
  configured: ReserveAmounts,
): ReserveAmounts {
  let { costMicros, tokens } = configured;
  for (const policy of policies) {
    const used = usedForMetric(
      policy.metric,
      totals.get(policy.id) ?? { messages: 0, tokens: 0, costMicros: 0 },
    );
    const remaining = Math.max(0, policy.limitValue - used);
    if (policy.metric === 'cost') costMicros = Math.min(costMicros, remaining);
    if (policy.metric === 'tokens') tokens = Math.min(tokens, remaining);
  }
  return { costMicros, tokens };
}

/** Record a refusal only after its admission transaction has rolled back. */
async function recordDenial(params: {
  organizationId: string;
  userId: string;
  modelSlug: string;
  policy: EvaluablePolicy;
  now: Date;
}): Promise<void> {
  try {
    await db
      .insert(schema.quotaDenial)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        policyId: params.policy.id,
        policyName: params.policy.name,
        modelSlug: params.modelSlug,
        day: params.now.toISOString().slice(0, 10),
        denialCount: 1,
      })
      .onConflictDoUpdate({
        target: [
          schema.quotaDenial.userId,
          schema.quotaDenial.policyId,
          schema.quotaDenial.modelSlug,
          schema.quotaDenial.day,
        ],
        set: { denialCount: sql`${schema.quotaDenial.denialCount} + 1`, updatedAt: new Date() },
      });
  } catch (error) {
    logger.error({ error, policyId: params.policy.id }, 'Failed to record a quota denial');
  }
}

class QuotaDenied extends Error {
  constructor(readonly policy: EvaluablePolicy) {
    super('Quota denied');
  }
}

/** Serialize admission and snapshot prices before generation, even for unlimited runs. */
export async function reserveQuota(params: {
  userId: string;
  role: UserRole;
  modelSlug: string;
  runId?: string;
  /**
   * Messages this run counts as. A reply continued after an approval is part
   * of a message that was already counted, so it reserves with 0.
   */
  messageCount?: number;
  policies: EvaluablePolicy[];
  pricing: ModelPricing;
  reserve: ReserveAmounts;
}): Promise<UsageReservation> {
  const organizationId = await getDefaultOrganizationId();
  let now = new Date();
  const id = await db
    .transaction(async (tx) => {
      if (!(await lockUsageOwner(tx, params.userId)))
        throw notFound('Usage owner no longer exists');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${params.userId}`}))`);
      now = new Date();
      const totalsByPolicy = new Map<string, WindowTotals>();
      for (const policy of params.policies) {
        const { start } = resolveWindow(policy, now);
        const totals = await windowTotalsIncludingPending(
          tx,
          params.userId,
          start,
          policy.modelSlugs,
        );
        totalsByPolicy.set(policy.id, totals);
        if (usedForMetric(policy.metric, totals) >= policy.limitValue)
          throw new QuotaDenied(policy);
      }
      const reserved = reservedAmounts(params.policies, totalsByPolicy, params.reserve);
      const [created] = await tx
        .insert(schema.usageEvent)
        .values({
          id: params.runId,
          organizationId,
          userId: params.userId,
          modelSlug: params.modelSlug,
          occurredAt: now,
          messageCount: params.messageCount ?? 1,
          tokensIn: 0,
          tokensOut: 0,
          costMicros: 0,
          reservedCostMicros: reserved.costMicros,
          reservedTokens: reserved.tokens,
          inputPriceMicros: params.pricing.inputPriceMicros,
          outputPriceMicros: params.pricing.outputPriceMicros,
          pending: true,
          usageUnknown: true,
        })
        .returning({ id: schema.usageEvent.id });
      if (!created) throw new Error('Failed to reserve quota');
      return created.id;
    })
    .catch(async (error) => {
      if (error instanceof QuotaDenied) {
        await recordDenial({
          organizationId,
          userId: params.userId,
          modelSlug: params.modelSlug,
          policy: error.policy,
          now,
        });
        throw quotaExceeded(limitMessage(error.policy));
      }
      throw error;
    });
  return { id, userId: params.userId, modelSlug: params.modelSlug, pricing: params.pricing };
}
