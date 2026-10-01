import { and, eq, gte, inArray, schema, sql } from '@oci/db';
import type { db } from '../../db/index.js';
import type { WindowTotals } from './policy.js';

/** Shared by admission and the meter. Unreported spend is held, not forgiven by age. */
export async function windowTotalsIncludingPending(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  start: Date,
  modelSlugs: string[],
): Promise<WindowTotals> {
  const conditions = [
    eq(schema.usageEvent.userId, userId),
    gte(schema.usageEvent.occurredAt, start),
  ];
  if (modelSlugs.length) conditions.push(inArray(schema.usageEvent.modelSlug, modelSlugs));
  const [totals] = await executor
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn}::bigint + ${schema.usageEvent.tokensOut}::bigint + ${schema.usageEvent.reservedTokens}::bigint), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros} + ${schema.usageEvent.reservedCostMicros}), 0)::bigint`,
    })
    .from(schema.usageEvent)
    .where(and(...conditions));
  return {
    messages: Number(totals?.messages ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    costMicros: Number(totals?.costMicros ?? 0),
  };
}
