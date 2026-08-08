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

/** One message is exact; spend and tokens are estimated then settled. */
const RESERVED_MESSAGE_COUNT = 1;

export interface UsageReservation {
  id: string;
  userId: string;
  modelSlug: string;
  pricing: ModelPricing;
}

/**
 * How much a reservation holds for the metrics that cannot be known up front.
 *
 * A reservation that held nothing let concurrent runs all observe the same
 * pre-spend total and collectively overshoot a budget. Reserving a flat amount
 * bounds that to roughly (concurrency cap x reserve).
 *
 * The reserve is clamped to what remains, so a user with a few cents left gets
 * exactly one more generation instead of being locked out of the tail of their
 * own allowance.
 */
export interface ReserveAmounts {
  costMicros: number;
  tokens: number;
}

function reservedAmounts(
  policies: EvaluablePolicy[],
  totals: Map<string, WindowTotals>,
  configured: ReserveAmounts,
): ReserveAmounts {
  let costMicros = configured.costMicros;
  let tokens = configured.tokens;

  for (const policy of policies) {
    const used = usedForMetric(policy.metric, totals.get(policy.id) ?? emptyTotals());
    const remaining = Math.max(0, policy.limitValue - used);

    if (policy.metric === 'cost') costMicros = Math.min(costMicros, remaining);
    if (policy.metric === 'tokens') tokens = Math.min(tokens, remaining);
  }

  return { costMicros, tokens };
}

function emptyTotals(): WindowTotals {
  return { messages: 0, tokens: 0, costMicros: 0 };
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
  modelSlugs: string[],
): Promise<WindowTotals> {
  const conditions = [
    eq(schema.usageEvent.userId, userId),
    gte(schema.usageEvent.occurredAt, start),
    // Settled rows always count; pending rows only while still live.
    or(
      eq(schema.usageEvent.pending, false),
      gte(schema.usageEvent.occurredAt, livePendingCutoff(now)),
    ),
  ];

  // A model-scoped policy only sees consumption by the models it governs.
  if (modelSlugs.length > 0) {
    conditions.push(inArray(schema.usageEvent.modelSlug, modelSlugs));
  }

  const [totals] = await tx
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      // A pending row's reserved weight counts until settlement replaces it.
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn} + ${schema.usageEvent.tokensOut} + ${schema.usageEvent.reservedTokens}), 0)::bigint`,
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

/**
 * Checks every policy and reserves the run in one serialized transaction, so
 * two concurrent requests cannot both observe the same pre-spend total. The
 * reservation is what closes the gap between checking before a stream and
 * recording after it.
 */
/**
 * Records that a limit refused a run.
 *
 * Written after the reservation transaction has already rolled back, never
 * inside it: the transaction aborts by design, so an insert made within it
 * would be discarded along with everything else. Failing to record a denial
 * must not turn a clean rejection into a server error, so this only logs.
 */
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
        set: {
          denialCount: sql`${schema.quotaDenial.denialCount} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    logger.error({ error, policyId: params.policy.id }, 'Failed to record a quota denial');
  }
}

/** Carries the refusing policy out of the transaction so it can be recorded. */
class QuotaDenied extends Error {
  constructor(readonly policy: EvaluablePolicy) {
    super('Quota denied');
  }
}

export async function reserveQuota(params: {
  userId: string;
  role: UserRole;
  modelSlug: string;
  policies: EvaluablePolicy[];
  pricing: ModelPricing;
  /** Read before the transaction so settings lookups never widen it. */
  reserve: ReserveAmounts;
}): Promise<UsageReservation> {
  const organizationId = await getDefaultOrganizationId();
  const now = new Date();

  const reservationId = await db
    .transaction(async (tx) => {
      // Serializes concurrent reservations for one user without locking the
      // table for everyone else.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${params.userId}`}))`);

      const totalsByPolicy = new Map<string, WindowTotals>();

      for (const policy of params.policies) {
        const { start } = resolveWindow(policy, now);
        const totals = await windowTotalsIncludingPending(
          tx,
          params.userId,
          start,
          now,
          policy.modelSlugs,
        );
        totalsByPolicy.set(policy.id, totals);

        if (usedForMetric(policy.metric, totals) >= policy.limitValue) {
          // Carried out of the transaction so the denial can be recorded after
          // the rollback rather than being discarded by it.
          throw new QuotaDenied(policy);
        }
      }

      const reserved = reservedAmounts(params.policies, totalsByPolicy, params.reserve);

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
          reservedCostMicros: reserved.costMicros,
          reservedTokens: reserved.tokens,
          inputPriceMicros: params.pricing.inputPriceMicros,
          outputPriceMicros: params.pricing.outputPriceMicros,
          pending: true,
        })
        .returning({ id: schema.usageEvent.id });

      if (!created) throw new Error('Failed to reserve quota');
      return created.id;
    })
    .catch(async (error) => {
      // The transaction has fully rolled back by now, which is exactly why the
      // denial is recorded here rather than beside the check that raised it.
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
    // Clearing the reserve as the actuals land is what releases any
    // over-reservation back to the user.
    .set({
      tokensIn,
      tokensOut,
      costMicros,
      reservedCostMicros: 0,
      reservedTokens: 0,
      pending: false,
    })
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
      // Drop the reserve too: an abandoned run never spent it.
      .set({ pending: false, reservedCostMicros: 0, reservedTokens: 0 })
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
