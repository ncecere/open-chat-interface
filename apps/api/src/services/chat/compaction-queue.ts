import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, schema, sql } from '@oci/db';
import {
  type CompactionFailureReason,
  type CompactionReason,
  type CompactionState,
  USER_ROLES,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { kickJob } from '../jobs/requests.js';
import { jobMayContinue } from '../jobs/runner.js';
import { resolveModelForRole } from '../models.js';
import {
  autoCompactEnabled,
  compactConversation,
  latestCompaction,
  serializeCompaction,
} from './compaction.js';
import { compactionDue } from './compaction-plan.js';
import { messageCost } from './context-budget.js';
import { historyParts } from './message-parts.js';

/**
 * Background conversation compaction: the queue. A request (automatic, after
 * a reply or when a turn had to leave turns out; or manual) is one row in
 * `conversation_compaction_job`, at most one per thread, so repeating it is
 * idempotent. Workers are the job runner's tick and an in-process kick right
 * after a request; both claim rows with `for update skip locked` and a lease,
 * so one conversation is summarised by one worker at a time across replicas,
 * and a request left by a restart is picked up when its lease runs out.
 *
 * Nothing here takes the reply claim or the thread lock while summarising:
 * sending, retrying, switching replies and approving never wait for (or are
 * refused because of) a summary. See docs/dev/v0.9-design.md.
 */

type JobRow = typeof schema.conversationCompactionJob.$inferSelect;

const MINUTE = 60_000;
/** A claim's lifetime: longer than the slowest summary (four 120 s calls). */
const LEASE_MS = 15 * MINUTE;
/** Failed summaries are retried after these delays, then given up. */
const RETRY_DELAYS_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE];
/** A spent allowance is checked again after this long… */
const ALLOWANCE_RETRY_MS = 15 * MINUTE;
/** …until the request is this old; the next reply asks again if still needed. */
const GIVE_UP_AFTER_MS = 24 * 60 * MINUTE;
/** Requests one worker pass handles at most. */
const BATCH = 10;

/**
 * Queues a compaction of the conversation. A manual request upgrades a
 * waiting automatic one (and runs now); a request while one is waiting
 * changes nothing else. An automatic request while one is running asks for
 * one more run afterwards, because turns were added since it was planned; a
 * manual request while one is running is that request.
 */
export async function requestCompaction(input: {
  threadId: string;
  userId: string;
  modelSlug: string;
  reason: CompactionReason;
  instructions?: string | null;
}): Promise<void> {
  const job = schema.conversationCompactionJob;
  const manualWhilePending = sql`excluded.reason = 'manual' and ${job.status} = 'pending'`;
  await db
    .insert(job)
    .values({
      threadId: input.threadId,
      userId: input.userId,
      reason: input.reason,
      modelSlug: input.modelSlug,
      instructions: input.instructions?.trim() || null,
    })
    .onConflictDoUpdate({
      target: job.threadId,
      set: {
        modelSlug: sql`case when ${job.status} = 'pending' then excluded.model_slug else ${job.modelSlug} end`,
        reason: sql`case when ${manualWhilePending} then 'manual' else ${job.reason} end`,
        instructions: sql`case when ${manualWhilePending} then excluded.instructions else ${job.instructions} end`,
        runAfter: sql`case when ${manualWhilePending} then now() else ${job.runAfter} end`,
        attempts: sql`case when ${manualWhilePending} then 0 else ${job.attempts} end`,
        rerun: sql`${job.rerun} or (${job.status} = 'running' and excluded.reason = 'automatic')`,
        updatedAt: new Date(),
      },
    });
  // Asking again replaces the report of an earlier failure.
  if (input.reason === 'manual') await clearCompactionFailure(input.threadId, input.userId);
  kickCompactionQueue();
}

/**
 * Queues an automatic compaction unless an administrator switched automatic
 * compaction off. Never throws: a reply goes ahead whatever happens here.
 */
export async function scheduleAutomaticCompaction(input: {
  threadId: string;
  userId: string;
  modelSlug: string;
}): Promise<boolean> {
  try {
    if (!(await automaticAllowed())) return false;
    await requestCompaction({ ...input, reason: 'automatic' });
    return true;
  } catch (error) {
    logger.warn({ error, threadId: input.threadId }, 'Could not queue a compaction');
    return false;
  }
}

/** What the turn knew about the history it sent, for the check after the reply. */
export type CompactionCheck = {
  /** The summary in use, the turns since its cut and the prompt, in input units. */
  historyUnits: number;
  budgetUnits: number;
  /** The turn had to leave older turns out. */
  limited: boolean;
};

/**
 * After a reply finished: queue a compaction when the history the model would
 * receive next time (what this turn had, plus this reply) is past the soft
 * threshold. Never throws.
 */
export async function scheduleCompactionAfterReply(input: {
  threadId: string;
  userId: string;
  modelSlug: string;
  check: CompactionCheck;
  reply: Pick<UIMessage, 'id' | 'parts'>;
}): Promise<boolean> {
  let replyUnits = 0;
  try {
    replyUnits = messageCost({
      id: input.reply.id,
      role: 'assistant',
      parts: historyParts(input.reply.parts, true),
    }).units;
  } catch {
    // An unusual part cannot be sized; the next turn decides instead.
  }
  if (
    !compactionDue({
      historyUnits: input.check.historyUnits + replyUnits,
      budgetUnits: input.check.budgetUnits,
      limited: input.check.limited,
    })
  )
    return false;
  return scheduleAutomaticCompaction(input);
}

/**
 * The summary in use and whether a summary is being made or due now (a
 * request waiting to retry later is not reported as pending).
 */
export async function compactionState(threadId: string, userId: string): Promise<CompactionState> {
  const job = schema.conversationCompactionJob;
  const failures = schema.conversationCompactionFailure;
  const [compaction, [pending], [failure]] = await Promise.all([
    latestCompaction(threadId, userId),
    db
      .select({ threadId: job.threadId })
      .from(job)
      .where(
        and(
          eq(job.threadId, threadId),
          eq(job.userId, userId),
          or(eq(job.status, 'running'), sql`${job.runAfter} <= now()`),
        ),
      )
      .limit(1),
    db
      .select({
        reason: failures.reason,
        instructions: failures.instructions,
        failedAt: failures.failedAt,
      })
      .from(failures)
      .where(and(eq(failures.threadId, threadId), eq(failures.userId, userId)))
      .limit(1),
  ]);
  return {
    compaction: compaction ? serializeCompaction(compaction) : null,
    pending: pending !== undefined,
    failure: failure ? { ...failure, failedAt: failure.failedAt.toISOString() } : null,
  };
}

/** Removes the report of a failed manual summary (dismissed, asked again, or succeeded since). */
export async function clearCompactionFailure(threadId: string, userId: string): Promise<void> {
  const failures = schema.conversationCompactionFailure;
  await db
    .delete(schema.conversationCompactionFailure)
    .where(and(eq(failures.threadId, threadId), eq(failures.userId, userId)));
}

/** Records why a summary the person asked for failed; a later failure replaces it. */
async function recordCompactionFailure(
  claimed: JobRow,
  reason: CompactionFailureReason,
): Promise<void> {
  const failures = schema.conversationCompactionFailure;
  const now = new Date();
  try {
    await db
      .insert(failures)
      .values({
        threadId: claimed.threadId,
        userId: claimed.userId,
        reason,
        instructions: claimed.instructions,
        failedAt: now,
      })
      .onConflictDoUpdate({
        target: failures.threadId,
        set: { reason, instructions: claimed.instructions, failedAt: now, updatedAt: now },
      });
  } catch (error) {
    // The thread went meanwhile, or the database is unavailable: the summary
    // still failed, but there is no one (or no way) to tell.
    logger.warn({ error, threadId: claimed.threadId }, 'Could not record a failed summary');
  }
}

/** The errors an error stands for: itself, its causes and a retry's attempts. */
function errorChain(error: unknown, depth = 0): unknown[] {
  if (!error || typeof error !== 'object' || depth > 4) return [error];
  const { cause, errors, lastError } = error as {
    cause?: unknown;
    errors?: unknown;
    lastError?: unknown;
  };
  const nested = [cause, lastError, ...(Array.isArray(errors) ? errors : [])].filter(
    (item) => item !== undefined && item !== error,
  );
  return [error, ...nested.flatMap((item) => errorChain(item, depth + 1))];
}

/**
 * The category reported for a summary that threw: the summary call's time
 * limit (an abort or timeout anywhere in the error) or anything else the
 * model or provider did (including refusing: model gone or too small).
 */
export function failureCategory(
  error: unknown,
): Extract<CompactionFailureReason, 'timeout' | 'model_error'> {
  const timedOut = errorChain(error).some((item) => {
    if (!item || typeof item !== 'object') return false;
    const { name, message } = item as { name?: unknown; message?: unknown };
    return (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      (typeof message === 'string' && /\btimed? ?out\b/i.test(message))
    );
  });
  return timedOut ? 'timeout' : 'model_error';
}

/** Claims the next due request, or one whose worker's lease ran out. */
async function claimNext(): Promise<JobRow | null> {
  const job = schema.conversationCompactionJob;
  const claimId = randomUUID();
  const [row] = await db
    .update(job)
    .set({
      status: 'running',
      claimId,
      leaseUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval`,
      attempts: sql`${job.attempts} + 1`,
      rerun: false,
      updatedAt: new Date(),
    })
    .where(
      eq(
        job.threadId,
        sql`(
          select candidate.thread_id from conversation_compaction_job candidate
          where (candidate.status = 'pending' and candidate.run_after <= now())
             or (candidate.status = 'running' and candidate.lease_until < now())
          order by candidate.run_after, candidate.thread_id
          limit 1
          for update skip locked
        )`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Ends a claim. Done: the row goes, unless another automatic request arrived
 * while it ran (then it waits for one more run). Retry: it waits until
 * `delayMs` from now. Only the claim's owner can do either.
 */
async function finish(
  claimed: JobRow,
  outcome: { done: true } | { retryInMs: number; attempts: number },
): Promise<void> {
  const job = schema.conversationCompactionJob;
  const mine = and(eq(job.threadId, claimed.threadId), eq(job.claimId, claimed.claimId!));
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(job).where(mine).for('update');
    if (!row) return;
    const waiting = {
      status: 'pending' as const,
      claimId: null,
      leaseUntil: null,
      rerun: false,
      updatedAt: new Date(),
    };
    if ('retryInMs' in outcome)
      await tx
        .update(job)
        .set({
          ...waiting,
          attempts: outcome.attempts,
          runAfter: sql`now() + ${`${outcome.retryInMs} milliseconds`}::interval`,
        })
        .where(mine);
    else if (row.rerun)
      await tx
        .update(job)
        .set({
          ...waiting,
          reason: 'automatic',
          instructions: null,
          attempts: 0,
          runAfter: sql`now()`,
        })
        .where(mine);
    else await tx.delete(job).where(mine);
  });
}

/** A summary was made: an earlier failure of this thread no longer matters. */
async function clearSucceeded(claimed: JobRow): Promise<void> {
  try {
    await clearCompactionFailure(claimed.threadId, claimed.userId);
  } catch (error) {
    logger.warn({ error, threadId: claimed.threadId }, 'Could not clear a failed summary');
  }
}

/** Automatic compaction is best effort: a setting that cannot be read leaves it off. */
async function automaticAllowed(): Promise<boolean> {
  try {
    return await autoCompactEnabled();
  } catch (error) {
    logger.warn({ error }, 'Could not read the automatic compaction setting');
    return false;
  }
}

/** Runs one claimed request. */
async function runClaimed(claimed: JobRow): Promise<void> {
  const done = { done: true } as const;
  const manual = claimed.reason === 'manual';
  const [owner] = await db
    .select({ role: schema.user.role, temporary: schema.thread.temporary })
    .from(schema.thread)
    .innerJoin(schema.user, eq(schema.user.id, schema.thread.userId))
    .where(
      and(
        eq(schema.thread.id, claimed.threadId),
        eq(schema.thread.userId, claimed.userId),
        isNull(schema.thread.deletedAt),
      ),
    );
  const role = USER_ROLES.find((candidate) => candidate === owner?.role);
  // Trashed (or gone) since it was requested: nothing to do.
  if (!owner || !role) return finish(claimed, done);
  // Switched off since it was queued (or unreadable): automatic requests go.
  if (claimed.reason === 'automatic' && !(await automaticAllowed())) return finish(claimed, done);
  try {
    const model = await resolveModelForRole(claimed.modelSlug, role);
    const outcome = await compactConversation({
      user: { id: claimed.userId, role },
      threadId: claimed.threadId,
      model,
      reason: claimed.reason,
      instructions: claimed.instructions,
    });
    if (outcome.status === 'created') await clearSucceeded(claimed);
    if (outcome.status === 'nothing' && manual)
      await recordCompactionFailure(claimed, 'nothing_to_summarise');
    if (outcome.status !== 'allowance') return finish(claimed, done);
    // A person who asked is told at once rather than left waiting up to a
    // day; they can ask again once their allowance allows it.
    if (manual) {
      await recordCompactionFailure(claimed, 'allowance');
      return finish(claimed, done);
    }
    if (Date.now() - claimed.createdAt.getTime() > GIVE_UP_AFTER_MS) return finish(claimed, done);
    // Waiting for the allowance is not a failed attempt.
    return finish(claimed, {
      retryInMs: ALLOWANCE_RETRY_MS,
      attempts: Math.max(0, claimed.attempts - 1),
    });
  } catch (error) {
    // A refusal (model gone or too small, no access) will not change by
    // retrying; a provider failure might.
    const permanent = error instanceof AppError && error.status < 500;
    const delay = RETRY_DELAYS_MS[claimed.attempts - 1];
    logger.warn(
      {
        error,
        threadId: claimed.threadId,
        attempts: claimed.attempts,
        retry: !permanent && !!delay,
      },
      'Background compaction failed',
    );
    // Reported at the first failure; a retry that succeeds later removes it.
    if (manual) await recordCompactionFailure(claimed, failureCategory(error));
    if (permanent || delay === undefined) return finish(claimed, done);
    return finish(claimed, { retryInMs: delay, attempts: claimed.attempts });
  }
}

/**
 * One worker pass: claims and runs due requests, one at a time, up to a
 * batch. Run by the job runner every minute and kicked after each request.
 * Returns how many requests it handled.
 */
export async function processCompactionQueue(options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? BATCH;
  let handled = 0;
  while (handled < limit) {
    // A failover may have taken the job's lock, or this replica is stopping.
    if (handled > 0 && !(await jobMayContinue())) break;
    const claimed = await claimNext();
    if (!claimed) break;
    handled++;
    try {
      await runClaimed(claimed);
    } catch (error) {
      // The lease runs out and another pass takes the request over.
      logger.error({ error, threadId: claimed.threadId }, 'Compaction request could not be ended');
    }
  }
  return handled;
}

let localPass: Promise<void> | null = null;
let again = false;

/** The job's name in services/jobs/index.ts, which imports this module. */
const COMPACTION_JOB_NAME = 'chat.compact-conversations';

/**
 * Starts a worker pass now rather than at the next tick: in this process, or
 * on a worker when this replica does not run jobs (OCI_ROLE=web). Requests
 * arriving during a local pass run in it or in one more pass afterwards.
 */
export function kickCompactionQueue(): void {
  kickJob(COMPACTION_JOB_NAME, kickLocalPass);
}

function kickLocalPass(): void {
  if (localPass) {
    again = true;
    return;
  }
  localPass = (async () => {
    do {
      again = false;
      try {
        await processCompactionQueue();
      } catch (error) {
        logger.warn({ error }, 'Background compaction pass failed');
      }
    } while (again);
  })().finally(() => {
    localPass = null;
  });
}

/** Resolves when this process's kicked pass (if any) has finished. */
export async function compactionQueueSettled(): Promise<void> {
  while (localPass) await localPass;
}
