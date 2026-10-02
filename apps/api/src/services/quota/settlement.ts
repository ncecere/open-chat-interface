import { and, eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { calculateCostMicros } from './policy.js';
import type { UsageReservation } from './reservation.js';

export type UsageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type UsageEvent = typeof schema.usageEvent.$inferSelect;
type TokenReport = {
  tokensIn?: number | null;
  tokensOut?: number | null;
  /**
   * A lower bound, not the full figure: a multi-step reply stopped mid-step
   * reports its finished steps. Recorded, but the usage stays unknown.
   */
  partial?: boolean;
} | null;
type Amounts = { messageCount: number; tokensIn: number; tokensOut: number; costMicros: number };

function tokenCount(value: number | null | undefined): number {
  if (value == null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError('Invalid provider token usage');
  }
  return value;
}

/** Parent first, so account deletion and usage mutations cannot form a lock cycle. */
export async function lockUsageOwner(tx: UsageTransaction, userId: string): Promise<boolean> {
  const [owner] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for('key share');
  return !!owner;
}

async function changeRollup(tx: UsageTransaction, event: UsageEvent, delta: Amounts) {
  const day = event.occurredAt.toISOString().slice(0, 10);
  const changes = {
    messageCount: sql`${schema.usageRecord.messageCount} + ${delta.messageCount}`,
    tokensIn: sql`${schema.usageRecord.tokensIn} + ${delta.tokensIn}`,
    tokensOut: sql`${schema.usageRecord.tokensOut} + ${delta.tokensOut}`,
    costMicros: sql`${schema.usageRecord.costMicros} + ${delta.costMicros}`,
    updatedAt: new Date(),
  };
  if (event.pending) {
    await tx
      .insert(schema.usageRecord)
      .values({
        organizationId: event.organizationId,
        userId: event.userId,
        modelSlug: event.modelSlug,
        day,
        ...delta,
      })
      .onConflictDoUpdate({
        target: [schema.usageRecord.userId, schema.usageRecord.modelSlug, schema.usageRecord.day],
        set: changes,
      });
    return;
  }
  // An unknown settlement was already rolled up atomically. Amend only an
  // existing consistent ledger; never manufacture a negative replacement row.
  const [changed] = await tx
    .update(schema.usageRecord)
    .set(changes)
    .where(
      and(
        eq(schema.usageRecord.organizationId, event.organizationId),
        eq(schema.usageRecord.userId, event.userId),
        eq(schema.usageRecord.modelSlug, event.modelSlug),
        eq(schema.usageRecord.day, day),
        sql`${changes.messageCount} >= 0 and ${changes.tokensIn} >= 0 and ${changes.tokensOut} >= 0 and ${changes.costMicros} >= 0`,
      ),
    )
    .returning({ id: schema.usageRecord.id });
  if (!changed) throw new Error('Usage rollup is missing or inconsistent');
}

/** Caller holds the owner and event locks. Both writes belong to this transaction. */
export async function settleLockedEvent(
  tx: UsageTransaction,
  event: UsageEvent,
  usage: TokenReport,
  source: 'producer' | 'sweep' = 'producer',
) {
  const known =
    source === 'producer' &&
    usage?.tokensIn != null &&
    usage.tokensOut != null &&
    usage.partial !== true;
  const reportedIn = tokenCount(usage?.tokensIn);
  const reportedOut = tokenCount(usage?.tokensOut);
  if (!event.pending && !event.usageUnknown) return;
  // Partial reports can race a sweep or each other. Merge cumulative maxima
  // until a complete report authoritatively replaces them (including downward
  // corrections). Missing fields and out-of-order retries never erase actuals.
  const tokensIn = known ? reportedIn : Math.max(event.tokensIn, reportedIn);
  const tokensOut = known ? reportedOut : Math.max(event.tokensOut, reportedOut);
  if (!event.pending && !known && tokensIn === event.tokensIn && tokensOut === event.tokensOut)
    return;
  const costMicros =
    source === 'sweep' ? event.costMicros : calculateCostMicros(event, tokensIn, tokensOut);
  await tx
    .update(schema.usageEvent)
    .set({
      tokensIn,
      tokensOut,
      costMicros,
      // Missing reports are not proof of free generation. Keep the remaining
      // estimate in the quota meter, but never mix it into measured rollups.
      reservedCostMicros: known
        ? 0
        : Math.max(0, event.costMicros + event.reservedCostMicros - costMicros),
      reservedTokens: known
        ? 0
        : Math.max(
            0,
            event.tokensIn + event.tokensOut + event.reservedTokens - tokensIn - tokensOut,
          ),
      pending: false,
      usageUnknown: !known,
    })
    .where(eq(schema.usageEvent.id, event.id));
  await changeRollup(tx, event, {
    messageCount: event.pending ? event.messageCount : 0,
    tokensIn: tokensIn - (event.pending ? 0 : event.tokensIn),
    tokensOut: tokensOut - (event.pending ? 0 : event.tokensOut),
    costMicros: costMicros - (event.pending ? 0 : event.costMicros),
  });
}

export async function settleReservation(
  reservation: UsageReservation,
  usage: TokenReport,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockUsageOwner(tx, reservation.userId))) return;
    const [event] = await tx
      .select()
      .from(schema.usageEvent)
      .where(
        and(
          eq(schema.usageEvent.id, reservation.id),
          eq(schema.usageEvent.userId, reservation.userId),
          eq(schema.usageEvent.modelSlug, reservation.modelSlug),
        ),
      )
      .for('update');
    if (event) await settleLockedEvent(tx, event, usage);
  });
}

/** Only for setup failures before model engagement, never a refund of measured usage. */
export async function releaseReservation(reservation: UsageReservation): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockUsageOwner(tx, reservation.userId))) return;
    const [event] = await tx
      .select()
      .from(schema.usageEvent)
      .where(
        and(
          eq(schema.usageEvent.id, reservation.id),
          eq(schema.usageEvent.userId, reservation.userId),
          eq(schema.usageEvent.modelSlug, reservation.modelSlug),
        ),
      )
      .for('update');
    if (!event || (!event.pending && !event.usageUnknown)) return;
    if (!event.pending) {
      await changeRollup(tx, event, {
        messageCount: -event.messageCount,
        tokensIn: -event.tokensIn,
        tokensOut: -event.tokensOut,
        costMicros: -event.costMicros,
      });
    }
    await tx.delete(schema.usageEvent).where(eq(schema.usageEvent.id, event.id));
  });
}
