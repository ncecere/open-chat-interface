import { and, eq, gte, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { conflict, rateLimited } from '../../lib/errors.js';
import { beginChatRun } from '../chat-streams.js';
import { acquireStreamSlot } from '../limits/concurrency.js';
import {
  recordUsage,
  reserveQuotaForRun,
  settleReservation,
  type UsageReservation,
} from '../quota/index.js';
import { nextPosition } from '../threads.js';
import type { PreparedTurn } from './prepare-turn.js';
import { failRunSetup, type RunResources } from './run-cleanup.js';

/** A process killed mid-stream must not leave the fallback thread lock forever. */
const STALE_RUN_MS = 15 * 60 * 1000;

export type AcquiredRun = RunResources & {
  startedAt: number;
  assistantMessage: { id: string };
};

/** Every acquisition after the stream slot is covered by the same failure boundary. */
export async function acquireRun({
  user,
  input,
  thread,
  resolved,
  promptMessageId,
  submittedMessageId,
}: PreparedTurn): Promise<AcquiredRun> {
  const startedAt = Date.now();
  const runIdentity: RunResources['runIdentity'] = {
    runId: crypto.randomUUID(),
    threadId: thread.id,
    userId: user.id,
  };
  const streamSlot = await acquireStreamSlot(user.id, user.role, runIdentity.runId);
  if (!streamSlot) {
    throw rateLimited(
      'You have too many responses generating at once. Wait for one to finish and try again.',
    );
  }

  const resources: RunResources = {
    runIdentity,
    streamSlot,
    persistence: 'unavailable',
    reservation: null,
  };
  try {
    resources.persistence = await beginChatRun(runIdentity);
    const persistence = resources.persistence;
    // Redis normally owns the thread lock; check the database when unavailable.
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
      // Do not touch the winning run or an immutable regeneration target.
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

    const position = await nextPosition(thread.id);
    const [assistantMessage] = await db
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
    if (!assistantMessage) throw new Error('Failed to create assistant message');
    resources.assistantMessage = assistantMessage;

    // Reserve only after validation and row creation. A denial now marks that
    // placeholder failed, rather than leaving a permanent streaming response.
    const reservation = await reserveQuotaForRun({
      userId: user.id,
      role: user.role,
      modelSlug: resolved.slug,
    });
    resources.reservation = reservation;
    return { startedAt, runIdentity, streamSlot, persistence, assistantMessage, reservation };
  } catch (error) {
    await failRunSetup(resources);
    throw error;
  }
}

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
