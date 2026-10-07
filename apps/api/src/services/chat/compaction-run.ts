import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, schema, sql } from '@oci/db';
import type { CompactionReason, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  releaseReservation,
  reserveQuotaForRun,
  settleReservation,
  type UsageReservation,
} from '../quota/index.js';
import type { ActiveCompaction } from './compaction-records.js';
import type { CompactionPlan } from './compaction-span.js';
import { type SummaryModel, summarize, type Tally } from './compaction-summary.js';
import { activeMessage } from './reply-path.js';
import { lockChatThread } from './thread-claim.js';

/**
 * The summary call is its own usage event (no message counted), with the
 * compaction's id. Every summary is made in the background, outside any
 * reply, so it is admitted against the person's allowance like a reply: a
 * spent allowance refuses it (and the queue tries again later).
 */
function openUsage(
  user: { id: string; role: UserRole },
  modelSlug: string,
  id: string,
): Promise<UsageReservation> {
  return reserveQuotaForRun({
    userId: user.id,
    role: user.role,
    modelSlug,
    runId: id,
    messageCount: 0,
  });
}

async function settle(reservation: UsageReservation, tally: Tally) {
  try {
    await settleReservation(
      reservation,
      tally.calls
        ? {
            tokensIn: tally.inputTokens,
            tokensOut: tally.outputTokens,
            ...(tally.complete ? {} : { partial: true }),
          }
        : null,
    );
  } catch (error) {
    logger.error({ error, reservationId: reservation.id }, 'Failed to settle compaction usage');
  }
}

/**
 * Records the compaction unless its input changed while it was being made.
 * The newest cut wins: when another compaction was recorded meanwhile, this
 * one is kept only if it reaches further (its summary carries everything
 * before its own cut forward, so it stands on its own). It is discarded when
 * the conversation was trashed or expired, or when any message it summarised
 * or its first kept message is gone or no longer on the active path.
 */
async function commitCompaction(
  values: typeof schema.conversationCompaction.$inferInsert,
  plan: CompactionPlan,
): Promise<ActiveCompaction | null> {
  return db.transaction(async (tx) => {
    try {
      // A short row lock that orders this with other commits. It is not the
      // reply claim: sending, retrying and approving never wait on a summary.
      await lockChatThread(tx, values.threadId, values.userId);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return null;
      throw error;
    }
    const [kept] = await tx
      .select({ position: schema.message.position, role: schema.message.role })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, values.firstKeptMessageId),
          eq(schema.message.threadId, values.threadId),
          activeMessage(),
        ),
      );
    if (kept?.role !== 'user') return null;
    const [latest] = await tx
      .select({ id: schema.conversationCompaction.id, position: schema.message.position })
      .from(schema.conversationCompaction)
      .innerJoin(
        schema.message,
        eq(schema.message.id, schema.conversationCompaction.firstKeptMessageId),
      )
      .where(eq(schema.conversationCompaction.threadId, values.threadId))
      .orderBy(
        desc(schema.conversationCompaction.createdAt),
        desc(schema.conversationCompaction.id),
      )
      .limit(1);
    if (latest && latest.id !== (plan.previous?.id ?? null) && latest.position >= kept.position)
      return null;
    const ids = plan.summarized.map((message) => message.id);
    let present = 0;
    for (let index = 0; index < ids.length; index += 1000) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.message)
        .where(
          and(
            inArray(schema.message.id, ids.slice(index, index + 1000)),
            eq(schema.message.threadId, values.threadId),
            activeMessage(),
          ),
        );
      present += Number(row?.count ?? 0);
    }
    if (present !== ids.length) return null;
    const [row] = await tx
      .insert(schema.conversationCompaction)
      .values({ ...values, createdAt: new Date() })
      .returning();
    return { ...row!, firstKeptPosition: kept.position };
  });
}

/**
 * Summarise, account for the call, and record. Null when the result was
 * discarded (see commitCompaction). A spent allowance throws QUOTA_EXCEEDED
 * before any model call.
 */
export async function runCompaction(
  plan: CompactionPlan,
  options: {
    user: { id: string; role: UserRole };
    threadId: string;
    model: SummaryModel;
    reason: CompactionReason;
    instructions?: string | null;
  },
): Promise<ActiveCompaction | null> {
  const id = randomUUID();
  const reservation = await openUsage(options.user, options.model.slug, id);
  const tally: Tally = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    started: false,
    complete: true,
  };
  let summary: string;
  try {
    summary = await summarize(plan, options.model, options.instructions, tally);
  } catch (error) {
    if (!tally.started) {
      // Refused before any model call: nothing was spent.
      await releaseReservation(reservation).catch((release: unknown) =>
        logger.error({ error: release, reservationId: reservation.id }, 'Failed to release'),
      );
      throw error;
    }
    // Whatever was measured is recorded; a failed call is not proof of no cost.
    tally.complete = false;
    await settle(reservation, tally);
    throw error;
  }
  await settle(reservation, tally);
  return commitCompaction(
    {
      id,
      threadId: options.threadId,
      userId: options.user.id,
      firstKeptMessageId: plan.firstKeptMessageId,
      summary,
      reason: options.reason,
      messagesSummarized: plan.messagesSummarized,
      tokensSummarized: plan.tokensSummarized,
      modelSlug: options.model.slug,
      tokensIn: tally.calls && tally.complete ? tally.inputTokens : null,
      tokensOut: tally.calls && tally.complete ? tally.outputTokens : null,
    },
    plan,
  );
}
