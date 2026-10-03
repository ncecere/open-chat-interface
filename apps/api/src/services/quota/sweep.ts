import { and, asc, eq, isNotNull, lt, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { activeChatClaim, livePendingCutoff, SWEEP_BATCH_SIZE } from './reservation-state.js';
import { lockUsageOwner, settleLockedEvent } from './settlement.js';

/** Unknown is not measured zero: late producer reports can still amend these rows. */
export async function sweepAbandonedReservations(now: Date = new Date()): Promise<number> {
  const eligible = () =>
    and(
      eq(schema.usageEvent.pending, true),
      // A deleted account's reservations are removed with it; one left by an
      // older release has no owner to settle for, and retention prunes it.
      isNotNull(schema.usageEvent.userId),
      lt(schema.usageEvent.occurredAt, livePendingCutoff(now)),
      sql`not (${activeChatClaim()})`,
    );
  const candidates = await db
    .select({ id: schema.usageEvent.id, userId: schema.usageEvent.userId })
    .from(schema.usageEvent)
    .where(eligible())
    .orderBy(asc(schema.usageEvent.occurredAt), asc(schema.usageEvent.id))
    .limit(SWEEP_BATCH_SIZE);
  let swept = 0;
  for (const candidate of candidates) {
    // One event per transaction preserves parent-first ordering and bounds lock
    // duration. Other sweepers skip a claimed event; retries cannot add it twice.
    swept += await db.transaction(async (tx) => {
      // Eligibility excludes events without an owner.
      if (!(await lockUsageOwner(tx, candidate.userId!))) return 0;
      const [event] = await tx
        .select()
        .from(schema.usageEvent)
        .where(and(eq(schema.usageEvent.id, candidate.id), eligible()))
        .for('update', { skipLocked: true });
      if (!event) return 0;
      await settleLockedEvent(
        tx,
        event,
        { tokensIn: event.tokensIn, tokensOut: event.tokensOut },
        'sweep',
      );
      return 1;
    });
  }
  if (swept)
    logger.warn({ count: swept }, 'Recorded unknown usage for abandoned quota reservations');
  return swept;
}
