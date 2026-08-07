import { and, eq, gte, or, schema, sql } from '@oci/db';
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
 * Settles reservations abandoned by a crashed process. They already stop
 * counting at the TTL; this keeps them from lingering as permanently pending
 * rows and records the message against the owner's history.
 */
export async function sweepAbandonedReservations(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(schema.usageEvent)
    .set({ pending: false })
    .where(
      and(
        eq(schema.usageEvent.pending, true),
        sql`${schema.usageEvent.occurredAt} < ${livePendingCutoff(now)}`,
      ),
    )
    .returning({ id: schema.usageEvent.id });

  if (rows.length > 0) {
    logger.warn({ count: rows.length }, 'Settled abandoned quota reservations');
  }
  return rows.length;
}
