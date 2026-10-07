import { type CompactionReason, ERROR_CODES, type UserRole } from '@oci/shared';
import { AppError, quotaExceeded, validationFailed } from '../../lib/errors.js';
import { allowanceExhausted } from '../quota/index.js';
import { softThresholdUnits } from './compaction-plan.js';
import {
  type ActiveCompaction,
  hasTurnsToSummarise,
  latestCompaction,
} from './compaction-records.js';
import { runCompaction } from './compaction-run.js';
import { planCompaction } from './compaction-span.js';
import { type SummaryModel, summaryChunkUnits } from './compaction-summary.js';
import { contextBudget } from './context-budget.js';

/**
 * Conversation compaction: the database and model half. A compaction
 * summarises the turns before a cut (plus any previous summary) with the
 * conversation's own model and records it; the model is then sent the summary
 * and the turns from the cut on. Messages are never changed or deleted.
 * Summaries are made only in the background (compaction-queue.ts); a reply
 * uses the latest one already recorded and never waits for a new one.
 */

export {
  type ActiveCompaction,
  autoCompactEnabled,
  latestCompaction,
  latestReplyModel,
  serializeCompaction,
} from './compaction-records.js';
export { summaryMaxTokens } from './compaction-summary.js';

export const NOTHING_TO_COMPACT =
  'There is nothing to summarise yet. A conversation needs at least two turns before the earlier ones can be summarised.';

export type CompactionOutcome =
  | { status: 'created'; compaction: ActiveCompaction }
  /** Nothing to summarise, or (automatic) the history is below the threshold. */
  | { status: 'nothing' }
  /** The person's allowance is spent: try again later. */
  | { status: 'allowance' }
  /** Made, but its input changed meanwhile or a further cut won. */
  | { status: 'discarded' };

/**
 * One background compaction, run by the queue (compaction-queue.ts), never
 * in a reply's path. Reads only finished turns before the cut: the newest
 * turn, which may still be generating, is always kept whole, so this takes no
 * reply claim. Automatic runs keep recent turns up to half the input budget
 * and only when the history is past the soft threshold; a manual run also
 * keeps at most half of the history since the previous cut, so a request
 * always summarises something once there are two turns.
 */
export async function compactConversation(input: {
  user: { id: string; role: UserRole };
  threadId: string;
  model: SummaryModel;
  reason: CompactionReason;
  instructions?: string | null;
}): Promise<CompactionOutcome> {
  const budget = contextBudget(input.model);
  const previous = await latestCompaction(input.threadId, input.user.id);
  const plan = await planCompaction({
    threadId: input.threadId,
    userId: input.user.id,
    previous,
    keepUnits: Math.floor(budget.units / 2),
    atMostHalf: input.reason === 'manual',
    ...(input.reason === 'automatic' ? { dueAboveUnits: softThresholdUnits(budget.units) } : {}),
  });
  if (!plan) return { status: 'nothing' };
  // Checked without recording a denial: the queue may ask again many times.
  if (await allowanceSpent(input.user, input.model.slug)) return { status: 'allowance' };
  let created: ActiveCompaction | null;
  try {
    created = await runCompaction(plan, {
      user: input.user,
      threadId: input.threadId,
      model: input.model,
      reason: input.reason,
      instructions: input.instructions,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === ERROR_CODES.QUOTA_EXCEEDED)
      return { status: 'allowance' };
    throw error;
  }
  return created ? { status: 'created', compaction: created } : { status: 'discarded' };
}

/** Whether a summary call would exceed the person's allowance now. */
export function allowanceSpent(
  user: { id: string; role: UserRole },
  modelSlug: string,
): Promise<boolean> {
  return allowanceExhausted({
    userId: user.id,
    role: user.role,
    modelSlug,
    runId: '',
    tokensIn: 0,
    tokensOut: 0,
    messageCount: 0,
  });
}

/**
 * The checks a manual request can answer at once, before it is queued: there
 * are two turns since the previous cut to summarise, the model can hold the
 * summariser's input, and the allowance is not spent.
 */
export async function assertCompactionPossible(input: {
  user: { id: string; role: UserRole };
  threadId: string;
  model: SummaryModel;
  instructions?: string | null;
}) {
  const previous = await latestCompaction(input.threadId, input.user.id);
  if (!(await hasTurnsToSummarise(input.threadId, input.user.id, previous)))
    throw validationFailed(NOTHING_TO_COMPACT);
  summaryChunkUnits(input.model, previous?.summary ?? null, input.instructions);
  if (await allowanceSpent(input.user, input.model.slug))
    throw quotaExceeded(
      'Your usage allowance is used up, so earlier messages cannot be summarised now.',
    );
}
