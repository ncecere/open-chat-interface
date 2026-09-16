import { and, eq, gte, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { conflict, rateLimited } from '../../lib/errors.js';
import { abandonChatRun, beginChatRun } from '../chat-streams.js';
import { acquireStreamSlot } from '../limits/concurrency.js';
import {
  recordUsage,
  reserveQuotaForRun,
  settleReservation,
  type UsageReservation,
} from '../quota/index.js';
import { nextPosition } from '../threads.js';
import type { PreparedTurn } from './prepare-turn.js';

/** A process killed mid-stream must not leave the fallback thread lock forever. */
const STALE_RUN_MS = 15 * 60 * 1000;

/** Acquire run resources in order, retaining each existing failure cleanup boundary. */
export async function acquireRun({
  user,
  input,
  thread,
  resolved,
  promptMessageId,
  submittedMessageId,
}: PreparedTurn) {
  const startedAt = Date.now();
  const runIdentity = {
    runId: crypto.randomUUID(),
    threadId: thread.id,
    userId: user.id,
  };
  // Held until generation genuinely ends, even across disconnect/resume. The
  // slot bounds simultaneous provider connections and quota reservations.
  const streamSlot = await acquireStreamSlot(user.id, user.role, runIdentity.runId);
  if (!streamSlot) {
    throw rateLimited(
      'You have too many responses generating at once. Wait for one to finish and try again.',
    );
  }

  let persistence: Awaited<ReturnType<typeof beginChatRun>>;
  try {
    persistence = await beginChatRun(runIdentity);
  } catch (error) {
    await streamSlot.release();
    throw error;
  }

  // Redis normally holds the per-thread lock. When unavailable, check for a
  // recent streaming assistant row rather than dropping the lock entirely.
  let databaseConflict = false;
  if (persistence === 'unavailable') {
    const [inFlight] = await db
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.threadId, thread.id),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
          gte(schema.message.createdAt, new Date(Date.now() - STALE_RUN_MS)),
        ),
      )
      .limit(1);
    databaseConflict = Boolean(inFlight);
  }

  if (persistence === 'conflict' || databaseConflict) {
    await streamSlot.release();
    // Roll back only the newly submitted user turn when another run won the
    // lock, so retrying cannot duplicate it. Regeneration never deletes a turn.
    if (submittedMessageId) {
      await db
        .delete(schema.message)
        .where(
          and(
            eq(schema.message.id, submittedMessageId),
            eq(schema.message.threadId, thread.id),
            eq(schema.message.userId, user.id),
          ),
        );
    }
    throw conflict('A response is already being generated for this thread');
  }

  let assistantMessage: { id: string };
  try {
    const position = await nextPosition(thread.id);
    const [inserted] = await db
      .insert(schema.message)
      .values({
        threadId: thread.id,
        userId: user.id,
        role: 'assistant',
        parts: [],
        position,
        parentMessageId: promptMessageId,
        modelSlug: resolved.slug,
        effort: input.effort ?? null,
        webSearchUsed: input.webSearch,
        status: 'streaming',
      })
      .returning({ id: schema.message.id });
    if (!inserted) throw new Error('Failed to create assistant message');
    assistantMessage = inserted;
  } catch (error) {
    await streamSlot.release();
    if (persistence === 'available') await abandonChatRun(runIdentity);
    throw error;
  }

  // Reserve last, after validation; the reservation makes concurrent requests
  // visible to each other throughout the stream.
  let reservation: UsageReservation | null;
  try {
    reservation = await reserveQuotaForRun({
      userId: user.id,
      role: user.role,
      modelSlug: resolved.slug,
    });
  } catch (error) {
    await streamSlot.release();
    if (persistence === 'available') await abandonChatRun(runIdentity);
    throw error;
  }

  return { startedAt, runIdentity, streamSlot, persistence, assistantMessage, reservation };
}

export type AcquiredRun = Awaited<ReturnType<typeof acquireRun>>;

/** Reserved runs settle their placeholder; without a policy, write usage directly. */
export async function settleUsage(
  reservation: UsageReservation | null,
  usage: { inputTokens?: number | null; outputTokens?: number | null } | null,
  fallback: { userId: string; modelSlug: string },
): Promise<void> {
  const tokensIn = usage?.inputTokens ?? 0;
  const tokensOut = usage?.outputTokens ?? 0;

  if (reservation) {
    await settleReservation(reservation, { tokensIn, tokensOut });
    return;
  }
  if (usage) await recordUsage({ ...fallback, tokensIn, tokensOut });
}
