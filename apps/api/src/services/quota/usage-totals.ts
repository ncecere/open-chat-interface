import { and, eq, gte, inArray, ne, schema, sql } from '@oci/db';
import type { db } from '../../db/index.js';
import { rollupRows, type UsageSource, usageSource } from '../usage-report/source.js';
import type { WindowTotals } from './policy.js';

/**
 * Shared by admission and the meter. Unreported spend is held, not forgiven by age.
 *
 * Reads the hourly rollups once their backfill has finished (the window's
 * whole hours, plus the change log not folded yet, plus the events of the
 * partial first hour, in one statement), otherwise the events; both return
 * the same totals. Admission calls it inside its transaction, after the
 * person's advisory lock, so the statement sees every committed reservation.
 */
export async function windowTotalsIncludingPending(
  executor: Pick<typeof db, 'select' | 'execute'>,
  userId: string,
  start: Date,
  modelSlugs: string[],
  /** Leave out one event, e.g. the run asking whether it may take another step. */
  excludeEventId?: string,
  source?: UsageSource,
): Promise<WindowTotals> {
  if ((source ?? (await usageSource())) === 'rollups') {
    const [totals] = await executor.execute<{
      messages: string;
      tokens: string;
      cost_micros: string;
    }>(sql`
      select coalesce(sum(r.quota_messages), 0)::bigint as messages,
        coalesce(sum(r.quota_tokens), 0)::bigint as tokens,
        coalesce(sum(r.quota_cost_micros), 0)::bigint as cost_micros
      from (${rollupRows({ start, level: 'person', userId, modelSlugs, excludeEventId })}) r
    `);
    return {
      messages: Number(totals?.messages ?? 0),
      tokens: Number(totals?.tokens ?? 0),
      costMicros: Number(totals?.cost_micros ?? 0),
    };
  }
  const conditions = [
    eq(schema.usageEvent.userId, userId),
    gte(schema.usageEvent.occurredAt, start),
  ];
  if (excludeEventId) conditions.push(ne(schema.usageEvent.id, excludeEventId));
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
