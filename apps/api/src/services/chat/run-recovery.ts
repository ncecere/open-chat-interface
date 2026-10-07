import { and, eq, gt, schema, sql } from '@oci/db';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import {
  activeChatRunId,
  capturedChatRunFrames,
  chatRunProducerActive,
  finalizeInterruptedChatRun,
  sharedRedis,
  touchChatRunHeartbeat,
} from '../chat-streams.js';
import { jobMayContinue } from '../jobs/runner.js';
import { lockUsageOwner, settleLockedEvent } from '../quota/settlement.js';
import { isRunActiveHere } from './active-runs.js';
import { settledParts } from './settled-parts.js';

/**
 * Replies whose producer is gone (v0.11 design, item 13 and the rolling-upgrade
 * test's gap 2).
 *
 * The streaming assistant row is the run's durable claim. Before v0.11 nothing
 * could tell a slow producer from a dead one, so a reply whose process was
 * killed stayed `streaming` for ever: the conversation refused new messages,
 * and a client resuming it waited on a stream nobody would finish.
 *
 * Now a producer shows it is alive two ways, on one timer: it refreshes the
 * claim's `updated_at` in PostgreSQL and a short-lived heartbeat key in Redis.
 * A run is interrupted only when **both** have been silent for `staleMs`
 * (and Redis has captured no event in that time either, which is all a
 * pre-v0.11 producer leaves during a rolling upgrade). Requiring both keeps a
 * database failover, or a producer that lost its Redis connection, from
 * looking like a crash. Without Redis, PostgreSQL decides alone.
 *
 * Recovery ends the cached stream as cancelled first (so readers finish with
 * what was captured), then saves the reply as interrupted: `cancelled`, with
 * what the person saw rebuilt from the captured stream and an `error_message`
 * saying why, then settles the usage reservation as unknown and frees the
 * concurrency slot. The update only applies while the claim is still stale, so
 * a producer that comes back first wins, and a late final save from one that
 * was only paused replaces the interrupted copy with the real reply.
 */
export const runLiveness = {
  /** Redis heartbeat interval; PostgreSQL is refreshed every second beat. */
  heartbeatMs: 5_000,
  staleMs: 20_000,
};

/** Stored on an interrupted reply; the web app shows it with Retry. */
export const INTERRUPTED_REPLY_MESSAGE =
  'This reply was interrupted because the server writing it stopped. Retry to generate it again.';

interface RunIdentity {
  runId: string;
  threadId: string;
  userId: string;
}

/** A first run's ID is its message ID; a continuation runs as `<message id>:<suffix>`. */
function messageIdOf(runId: string): string {
  return runId.split(':', 1)[0]!;
}

const staleBefore = () =>
  sql`now() - make_interval(secs => ${runLiveness.staleMs / 1000}::double precision)`;

/** Starts the run's heartbeat. Stop it once the run's final state is saved. */
export function startRunHeartbeat(identity: RunIdentity): () => void {
  const messageId = messageIdOf(identity.runId);
  let beating = false;
  let beats = 0;
  // Best effort, and never a reason for the reply itself to fail.
  const touchRedis = () =>
    Promise.resolve()
      .then(() => touchChatRunHeartbeat(identity.runId, runLiveness.staleMs))
      .catch(() => undefined);
  const beat = async () => {
    if (beating) return;
    beating = true;
    try {
      // Independent: a database failover must not silence the Redis heartbeat.
      // PostgreSQL every other beat: one small update per reply per 10 s.
      await Promise.allSettled([
        touchRedis(),
        ++beats % 2 === 0
          ? db
              .update(schema.message)
              .set({ updatedAt: sql`now()` })
              .where(
                and(
                  eq(schema.message.id, messageId),
                  eq(schema.message.userId, identity.userId),
                  eq(schema.message.status, 'streaming'),
                ),
              )
          : null,
      ]);
    } finally {
      beating = false;
    }
  };
  // The claim was just written, so PostgreSQL is fresh; Redis needs a first beat.
  void touchRedis();
  const timer = setInterval(() => void beat(), runLiveness.heartbeatMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Replays the captured stream into the message the reader saw; null if it cannot. */
async function rebuildReply(
  runId: string,
  messageId: string,
  saved: UIMessage['parts'],
): Promise<UIMessage['parts'] | null> {
  const frames = await capturedChatRunFrames(runId);
  if (!frames?.length) return null;
  const chunks: UIMessageChunk[] = [];
  for (const frame of frames) {
    if (!frame.startsWith('data:')) continue;
    const data = frame.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(data) as UIMessageChunk);
    } catch {
      return null;
    }
  }
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  // A continued reply's stream adds to the parts it already had.
  const base: UIMessage | undefined = saved.length
    ? { id: messageId, role: 'assistant', parts: saved }
    : undefined;
  let latest: UIMessage | undefined;
  let failed = false;
  for await (const message of readUIMessageStream({
    message: base,
    stream,
    onError: () => {
      failed = true;
    },
  })) {
    latest = message;
  }
  if (failed || !latest) return null;
  // Nothing more will arrive (the rule every saved reply follows).
  return settledParts(latest.parts);
}

async function settleReservation(identity: RunIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockUsageOwner(tx, identity.userId))) return;
    const [event] = await tx
      .select()
      .from(schema.usageEvent)
      .where(
        and(
          eq(schema.usageEvent.id, identity.runId),
          eq(schema.usageEvent.userId, identity.userId),
          eq(schema.usageEvent.pending, true),
        ),
      )
      .for('update', { skipLocked: true });
    // What the provider used is unknown: keep the estimate, as the quota sweep does.
    if (event)
      await settleLockedEvent(
        tx,
        event,
        { tokensIn: event.tokensIn, tokensOut: event.tokensOut },
        'sweep',
      );
  });
}

/** The run's concurrency slot (services/limits/concurrency.ts keys them by person). */
async function releaseSlot(identity: RunIdentity): Promise<void> {
  const redis = await sharedRedis();
  await redis?.zrem(`oci:concurrency:user:${identity.userId}`, identity.runId);
}

/**
 * Ends the run as interrupted if its producer is gone. Returns true only when
 * this call did; false while the producer may be alive or once another
 * replica recovered it.
 */
export async function recoverInterruptedRun(identity: RunIdentity): Promise<boolean> {
  // Never this process's own reply, however long its database writes are failing.
  if (isRunActiveHere(identity.runId)) return false;
  // Cheapest next: a live producer's heartbeat key answers in one Redis call.
  const active = await chatRunProducerActive(identity.runId, runLiveness.staleMs);
  if (active) return false;
  const messageId = messageIdOf(identity.runId);
  const claim = and(
    eq(schema.message.id, messageId),
    eq(schema.message.threadId, identity.threadId),
    eq(schema.message.userId, identity.userId),
    eq(schema.message.role, 'assistant'),
    eq(schema.message.status, 'streaming'),
    sql`${schema.message.updatedAt} < ${staleBefore()}`,
  );
  const [row] = await db
    .select({ parts: schema.message.parts })
    .from(schema.message)
    .where(claim)
    .limit(1);
  if (!row) return false;
  const saved = row.parts as unknown as UIMessage['parts'];
  const parts = await rebuildReply(identity.runId, messageId, saved).catch(() => null);
  await finalizeInterruptedChatRun(identity, 'interrupted');
  const [recovered] = await db
    .update(schema.message)
    .set({
      status: 'cancelled',
      errorMessage: INTERRUPTED_REPLY_MESSAGE,
      parts: (parts ?? saved) as unknown as Record<string, unknown>[],
      updatedAt: new Date(),
    })
    .where(claim)
    .returning({ id: schema.message.id });
  if (!recovered) return false;
  await Promise.all([
    settleReservation(identity).catch((error) =>
      logger.error({ error, runId: identity.runId }, 'Settling an interrupted reply failed'),
    ),
    releaseSlot(identity).catch(() => undefined),
  ]);
  logger.warn(
    { runId: identity.runId, threadId: identity.threadId, rebuilt: parts !== null },
    'Saved a reply whose producer stopped as interrupted',
  );
  return true;
}

/**
 * The claim blocking a new turn in this thread, if its producer is gone:
 * recovers it and returns true so admission can try again.
 */
export async function recoverStaleClaim(claim: {
  messageId: string;
  threadId: string;
  userId: string;
}): Promise<boolean> {
  const cached = await activeChatRunId(claim.threadId);
  const runId = cached && messageIdOf(cached) === claim.messageId ? cached : claim.messageId;
  return recoverInterruptedRun({ runId, threadId: claim.threadId, userId: claim.userId });
}

/** How far back the sweep looks for runs: replies do not stream for hours. */
const SWEEP_WINDOW_MS = 6 * 60 * 60 * 1000;
const SWEEP_BATCH = 100;

/**
 * Background sweep for interrupted replies nobody is reading. Every run has a
 * pending usage event with the run's ID until it settles, and those are found
 * through the `occurred_at` index, so the sweep never scans `message`.
 */
export async function recoverInterruptedReplies(now: Date = new Date()): Promise<number> {
  const candidates = await db
    .select({
      runId: schema.usageEvent.id,
      userId: schema.message.userId,
      threadId: schema.message.threadId,
    })
    .from(schema.usageEvent)
    .innerJoin(
      schema.message,
      and(
        sql`${schema.message.id} = split_part(${schema.usageEvent.id}, ':', 1)`,
        eq(schema.message.userId, schema.usageEvent.userId),
      ),
    )
    .where(
      and(
        gt(schema.usageEvent.occurredAt, new Date(now.getTime() - SWEEP_WINDOW_MS)),
        eq(schema.usageEvent.pending, true),
        eq(schema.message.role, 'assistant'),
        eq(schema.message.status, 'streaming'),
        sql`${schema.message.updatedAt} < ${staleBefore()}`,
      ),
    )
    .limit(SWEEP_BATCH);
  let recovered = 0;
  for (const [index, candidate] of candidates.entries()) {
    // A failover may have taken the job's lock, or this replica is stopping.
    if (index > 0 && !(await jobMayContinue())) break;
    try {
      if (await recoverInterruptedRun(candidate)) recovered++;
    } catch (error) {
      logger.error({ error, runId: candidate.runId }, 'Recovering an interrupted reply failed');
    }
  }
  return recovered;
}
