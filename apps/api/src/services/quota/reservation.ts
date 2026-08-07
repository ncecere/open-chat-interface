import { and, eq, gte, inArray, or, schema, sql } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { quotaExceeded } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  calculateCostMicros,
  type EvaluablePolicy,
  limitMessage,
  type ModelPricing,
  usedForMetric,
  type WindowTotals,
} from './policy.js';
import { resolveWindow } from './windows.js';

/**
 * How long a reservation counts against a quota before it is treated as
 * abandoned. A process that dies mid-stream never settles its row, so without
 * this a crash would permanently consume allowance.
 */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * What a reservation costs before real token counts exist. One message is
 * exact; tokens and spend are unknowable up front, so a reservation holds no
 * token weight and relies on settlement to record actuals.
 */
const RESERVED_MESSAGE_COUNT = 1;

export interface UsageReservation {
  id: string;
  userId: string;
  modelSlug: string;
  pricing: ModelPricing;
}

/** Reservations older than the TTL are ignored rather than blocking forever. */
function livePendingCutoff(now: Date): Date {
  return new Date(now.getTime() - RESERVATION_TTL_MS);
}

/**
 * Sums settled usage plus still-live reservations inside a window. Reservations
 * are what make concurrent requests visible to each other.
 */
async function windowTotalsIncludingPending(
  tx: Pick<typeof db, 'select'>,
  userId: string,
  start: Date,
  now: Date,
): Promise<WindowTotals> {
  const [totals] = await tx
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn} + ${schema.usageEvent.tokensOut}), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros}), 0)::bigint`,
    })
    .from(schema.usageEvent)
    .where(
      and(
        eq(schema.usageEvent.userId, userId),
        gte(schema.usageEvent.occurredAt, start),
        // Settled rows always count; pending rows only while still live.
        or(
          eq(schema.usageEvent.pending, false),
          gte(schema.usageEvent.occurredAt, livePendingCutoff(now)),
        ),
      ),
    );

  return {
    messages: Number(totals?.messages ?? 0),
    tokens: Number(totals?.tokens ?? 0),
    costMicros: Number(totals?.costMicros ?? 0),
  };
}

/**
 * Checks every policy and reserves the run in one serialized transaction, so
 * two concurrent requests cannot both observe the same pre-spend total. The
 * reservation is what closes the gap between checking before a stream and
 * recording after it.
 */
export async function reserveQuota(params: {
  userId: string;
  role: UserRole;
  modelSlug: string;
  policies: EvaluablePolicy[];
  pricing: ModelPricing;
}): Promise<UsageReservation> {
  const organizationId = await getDefaultOrganizationId();
  const now = new Date();

  const reservationId = await db.transaction(async (tx) => {
    // Serializes concurrent reservations for one user without locking the
    // table for everyone else.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${params.userId}`}))`);

    for (const policy of params.policies) {
      const { start } = resolveWindow(policy, now);
      const totals = await windowTotalsIncludingPending(tx, params.userId, start, now);

      if (usedForMetric(policy.metric, totals) >= policy.limitValue) {
        throw quotaExceeded(limitMessage(policy));
      }
    }

    const [created] = await tx
      .insert(schema.usageEvent)
      .values({
        organizationId,
        userId: params.userId,
        modelSlug: params.modelSlug,
        occurredAt: now,
        messageCount: RESERVED_MESSAGE_COUNT,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: 0,
        inputPriceMicros: params.pricing.inputPriceMicros,
        outputPriceMicros: params.pricing.outputPriceMicros,
        pending: true,
      })
      .returning({ id: schema.usageEvent.id });

    if (!created) throw new Error('Failed to reserve quota');
    return created.id;
  });

  return {
    id: reservationId,
    userId: params.userId,
    modelSlug: params.modelSlug,
    pricing: params.pricing,
  };
}

/**
 * Replaces a reservation with measured usage. Runs that produced no usage
 * report still settle at zero tokens so the message itself remains counted;
 * this is what makes repeated cancellation visible to a message quota.
 */
export async function settleReservation(
  reservation: UsageReservation,
  usage: { tokensIn: number; tokensOut: number } | null,
): Promise<void> {
  const tokensIn = Math.max(0, usage?.tokensIn ?? 0);
  const tokensOut = Math.max(0, usage?.tokensOut ?? 0);
  const costMicros = calculateCostMicros(reservation.pricing, tokensIn, tokensOut);

  const [settled] = await db
    .update(schema.usageEvent)
    .set({ tokensIn, tokensOut, costMicros, pending: false })
    .where(and(eq(schema.usageEvent.id, reservation.id), eq(schema.usageEvent.pending, true)))
    .returning({
      organizationId: schema.usageEvent.organizationId,
      occurredAt: schema.usageEvent.occurredAt,
    });

  // Already settled or swept; do not double-count the rollup.
  if (!settled) return;

  await db
    .insert(schema.usageRecord)
    .values({
      organizationId: settled.organizationId,
      userId: reservation.userId,
      modelSlug: reservation.modelSlug,
      day: settled.occurredAt.toISOString().slice(0, 10),
      messageCount: 1,
      tokensIn,
      tokensOut,
      costMicros,
    })
    .onConflictDoUpdate({
      target: [schema.usageRecord.userId, schema.usageRecord.modelSlug, schema.usageRecord.day],
      set: {
        messageCount: sql`${schema.usageRecord.messageCount} + 1`,
        tokensIn: sql`${schema.usageRecord.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${schema.usageRecord.tokensOut} + ${tokensOut}`,
        costMicros: sql`${schema.usageRecord.costMicros} + ${costMicros}`,
      },
    });
}

/**
 * Drops a reservation without recording usage. Used when the run fails before
 * the model was ever engaged, so nothing was actually spent.
 */
export async function releaseReservation(reservation: UsageReservation): Promise<void> {
  await db
    .delete(schema.usageEvent)
    .where(and(eq(schema.usageEvent.id, reservation.id), eq(schema.usageEvent.pending, true)))
    .catch((error) =>
      logger.error({ error, reservationId: reservation.id }, 'Failed to release reservation'),
    );
}

/**
 * Settles reservations abandoned by a crashed process.
 *
 * The rollup is written here as well as in `settleReservation`, because a run
 * that outlives the TTL is swept while still streaming: its own settlement
 * then finds the row no longer pending and records nothing. Without this the
 * message and its spend would vanish from the daily totals.
 *
 * `skipLocked` lets several replicas sweep at once without contending or
 * double-counting: each claims a disjoint set of rows.
 */
export async function sweepAbandonedReservations(now: Date = new Date()): Promise<number> {
  const swept = await db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      id: string;
      organization_id: string;
      user_id: string;
      model_slug: string;
      occurred_at: Date;
      message_count: number;
      tokens_in: number;
      tokens_out: number;
      cost_micros: string;
    }>(sql`
      select id, organization_id, user_id, model_slug, occurred_at,
             message_count, tokens_in, tokens_out, cost_micros
      from usage_event
      where pending = true and occurred_at < ${livePendingCutoff(now).toISOString()}::timestamptz
      for update skip locked
    `);

    if (claimed.length === 0) return [];

    await tx
      .update(schema.usageEvent)
      .set({ pending: false })
      .where(
        inArray(
          schema.usageEvent.id,
          claimed.map((row) => row.id),
        ),
      );

    return claimed;
  });

  // Reflect the swept events in the rollup that drives admin analytics.
  for (const row of swept) {
    await db
      .insert(schema.usageRecord)
      .values({
        organizationId: row.organization_id,
        userId: row.user_id,
        modelSlug: row.model_slug,
        day: new Date(row.occurred_at).toISOString().slice(0, 10),
        messageCount: row.message_count,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costMicros: Number(row.cost_micros),
      })
      .onConflictDoUpdate({
        target: [schema.usageRecord.userId, schema.usageRecord.modelSlug, schema.usageRecord.day],
        set: {
          messageCount: sql`${schema.usageRecord.messageCount} + ${row.message_count}`,
          tokensIn: sql`${schema.usageRecord.tokensIn} + ${row.tokens_in}`,
          tokensOut: sql`${schema.usageRecord.tokensOut} + ${row.tokens_out}`,
          costMicros: sql`${schema.usageRecord.costMicros} + ${Number(row.cost_micros)}`,
        },
      })
      .catch((error) =>
        logger.error({ error, eventId: row.id }, 'Failed to roll up a swept reservation'),
      );
  }

  if (swept.length > 0) {
    logger.warn({ count: swept.length }, 'Settled abandoned quota reservations');
  }
  return swept.length;
}
