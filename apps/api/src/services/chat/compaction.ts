import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, schema, sql } from '@oci/db';
import {
  type CompactionReason,
  type ConversationCompaction,
  ERROR_CODES,
  type UserRole,
} from '@oci/shared';
import { generateText } from 'ai';
import { db } from '../../db/index.js';
import { AppError, quotaExceeded, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isImage } from '../attachments/validate.js';
import {
  allowanceExhausted,
  releaseReservation,
  reserveQuotaForRun,
  settleReservation,
  type UsageReservation,
} from '../quota/index.js';
import { getSetting } from '../settings.js';
import {
  chunkTranscript,
  groupTurns,
  MIN_CHUNK_UNITS,
  SUMMARY_PROMPT_OVERHEAD,
  SUMMARY_SYSTEM,
  selectCutPoint,
  serializeConversation,
  softThresholdUnits,
  summaryPrompt,
  withSummary,
} from './compaction-plan.js';
import {
  contextBudget,
  IMAGE_INPUT_UNITS,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  messageCost,
  textCost,
} from './context-budget.js';
import { boundedParts, payloadBytes } from './context-history.js';
import { historyParts } from './message-parts.js';
import { activeMessage } from './reply-path.js';
import { lockChatThread } from './thread-claim.js';
import type { TurnContext } from './turn-context.js';

/**
 * Conversation compaction: the database and model half. A compaction
 * summarises the turns before a cut (plus any previous summary) with the
 * conversation's own model and records it; the model is then sent the summary
 * and the turns from the cut on. Messages are never changed or deleted.
 * Summaries are made only in the background (compaction-queue.ts); a reply
 * uses the latest one already recorded and never waits for a new one.
 */

type CompactionRow = typeof schema.conversationCompaction.$inferSelect;
/** The compaction in use, with the position its kept messages start at. */
export type ActiveCompaction = CompactionRow & { firstKeptPosition: number };
type SummaryModel = Pick<
  TurnContext['resolved'],
  'slug' | 'languageModel' | 'contextWindow' | 'maxOutputTokens'
>;
type SpanMessage = { id: string; role: 'user' | 'assistant'; parts: unknown };

/** Messages read for one compaction: newest first, then trimmed to these bounds. */
const MAX_SPAN_MESSAGES = 2000;
const MAX_SPAN_BYTES = 8 * 1024 * 1024;
/** Upper bound for one summary, in tokens. */
const MAX_SUMMARY_TOKENS = 4096;
const SUMMARY_TIMEOUT_MS = 120_000;

export const NOTHING_TO_COMPACT =
  'There is nothing to summarise yet. A conversation needs at least two turns before the earlier ones can be summarised.';

/**
 * The most a summary may be, in tokens: small beside the input budget, so the
 * kept turns and the summary fit together.
 */
export function summaryMaxTokens(budget: { units: number; outputTokens: number }): number {
  return Math.max(
    256,
    Math.min(budget.outputTokens, MAX_SUMMARY_TOKENS, Math.floor(budget.units / 16)),
  );
}

/** Automatic compaction is on unless an administrator turned it off. */
export async function autoCompactEnabled(): Promise<boolean> {
  const chat = await getSetting('chat');
  return chat.autoCompact !== false;
}

export function serializeCompaction(row: CompactionRow): ConversationCompaction {
  return {
    id: row.id,
    threadId: row.threadId,
    firstKeptMessageId: row.firstKeptMessageId,
    summary: row.summary,
    reason: row.reason,
    messagesSummarized: row.messagesSummarized,
    tokensSummarized: row.tokensSummarized,
    modelSlug: row.modelSlug,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The newest compaction of a thread, or null. */
export async function latestCompaction(
  threadId: string,
  userId: string,
): Promise<ActiveCompaction | null> {
  const [row] = await db
    .select({ compaction: schema.conversationCompaction, position: schema.message.position })
    .from(schema.conversationCompaction)
    .innerJoin(
      schema.message,
      eq(schema.message.id, schema.conversationCompaction.firstKeptMessageId),
    )
    .where(
      and(
        eq(schema.conversationCompaction.threadId, threadId),
        eq(schema.conversationCompaction.userId, userId),
        eq(schema.message.threadId, threadId),
      ),
    )
    .orderBy(desc(schema.conversationCompaction.createdAt), desc(schema.conversationCompaction.id))
    .limit(1);
  return row ? { ...row.compaction, firstKeptPosition: row.position } : null;
}

/**
 * The active-path messages from the previous cut (or the start) on. Bounded
 * like model context: newest first, so a backlog too large to read loses its
 * oldest messages, never the recent ones. The newest turn (possibly still
 * generating) is read only to size it: it is always kept, never summarised.
 */
async function loadSpan(input: { threadId: string; userId: string; fromPosition: number | null }) {
  const candidates = await db
    .select({ id: schema.message.id, bytes: payloadBytes })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, input.threadId),
        eq(schema.message.userId, input.userId),
        inArray(schema.message.role, ['user', 'assistant']),
        activeMessage(),
        input.fromPosition == null ? undefined : gte(schema.message.position, input.fromPosition),
      ),
    )
    .orderBy(desc(schema.message.position), desc(schema.message.createdAt), desc(schema.message.id))
    .limit(MAX_SPAN_MESSAGES);
  const ids: string[] = [];
  let bytes = 0;
  for (const row of candidates) {
    if (bytes + row.bytes > MAX_SPAN_BYTES) break;
    ids.push(row.id);
    bytes += row.bytes;
  }
  if (!ids.length) return { messages: [], bytes };
  const rows = await db
    .select({ id: schema.message.id, role: schema.message.role, parts: boundedParts })
    .from(schema.message)
    .where(and(inArray(schema.message.id, ids), eq(schema.message.threadId, input.threadId)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const messages = ids.reverse().flatMap((id) => {
    const row = byId.get(id);
    return row ? [row as SpanMessage] : [];
  });
  return { messages, bytes };
}

/** Estimated input units of each message's files, as model context counts them. */
async function attachmentUnits(messageIds: string[]): Promise<Map<string, number>> {
  const units = new Map<string, number>();
  for (let index = 0; index < messageIds.length; index += 1000) {
    const rows = await db
      .select({
        messageId: schema.attachment.messageId,
        filename: schema.attachment.filename,
        mimeType: schema.attachment.mimeType,
        textBytes: sql<number>`coalesce(octet_length(${schema.attachment.extractedText}), 0)::int`,
      })
      .from(schema.attachment)
      .where(
        and(
          inArray(schema.attachment.messageId, messageIds.slice(index, index + 1000)),
          isNull(schema.attachment.deletedAt),
        ),
      );
    for (const row of rows) {
      const cost =
        Buffer.byteLength(row.filename) +
        Buffer.byteLength(row.mimeType) +
        128 +
        (isImage(row.mimeType) ? IMAGE_INPUT_UNITS : Number(row.textBytes));
      units.set(row.messageId!, (units.get(row.messageId!) ?? 0) + cost);
    }
  }
  return units;
}

type CompactionPlan = {
  previous: ActiveCompaction | null;
  summarized: SpanMessage[];
  firstKeptMessageId: string;
  messagesSummarized: number;
  tokensSummarized: number;
};

/**
 * Where to cut and what to summarise. Keeps the newest turns up to
 * `keepUnits` (with `atMostHalf`, also at most half of what is there now, so
 * a request always summarises something once there are two turns). Null when
 * the cut would not move past the previous one, or when `dueAboveUnits` is
 * given and the history the model would receive (the previous summary plus
 * the turns since its cut) is not above it nor near the history ceilings.
 */
async function planCompaction(input: {
  threadId: string;
  userId: string;
  previous: ActiveCompaction | null;
  keepUnits: number;
  atMostHalf?: boolean;
  dueAboveUnits?: number;
}): Promise<CompactionPlan | null> {
  const { messages, bytes } = await loadSpan({
    threadId: input.threadId,
    userId: input.userId,
    fromPosition: input.previous?.firstKeptPosition ?? null,
  });
  const files = await attachmentUnits(messages.map((message) => message.id));
  const groups = groupTurns(
    messages,
    (message) =>
      messageCost({ id: message.id, role: message.role, parts: historyParts(message.parts, true) })
        .units + (files.get(message.id) ?? 0),
  );
  const total = groups.reduce((sum, group) => sum + group.units, 0);
  const summaryUnits = input.previous ? textCost(withSummary('', input.previous.summary)).units : 0;
  // Due past the soft threshold, or when the history ceilings (messages,
  // bytes) are as close, since those also make a turn leave turns out.
  const due =
    total + summaryUnits > (input.dueAboveUnits ?? -1) ||
    messages.length > softThresholdUnits(MAX_HISTORY_MESSAGES) ||
    bytes > softThresholdUnits(MAX_HISTORY_BYTES);
  if (!due) return null;
  const keep = input.atMostHalf
    ? Math.min(input.keepUnits, Math.floor(total / 2))
    : input.keepUnits;
  const cut = selectCutPoint(groups, keep);
  if (cut === null) return null;
  const summarizedGroups = groups.slice(0, cut);
  const summarized = summarizedGroups.flatMap((group) => group.messages);
  const units =
    summarizedGroups.reduce((sum, group) => sum + group.units, 0) +
    Buffer.byteLength(input.previous?.summary ?? '');
  return {
    previous: input.previous,
    summarized,
    firstKeptMessageId: groups[cut]!.messages[0]!.id,
    messagesSummarized: (input.previous?.messagesSummarized ?? 0) + summarized.length,
    // Units are UTF-8 bytes; four per token is the usual rough figure.
    tokensSummarized: Math.ceil(units / 4),
  };
}

/**
 * Room for transcript in one summariser call, beside its instructions, the
 * previous summary and the summary it writes. Refused when too small.
 */
function summaryChunkUnits(
  model: SummaryModel,
  previousSummary: string | null,
  instructions: string | null | undefined,
): number {
  const budget = contextBudget(model);
  const fixed =
    SUMMARY_PROMPT_OVERHEAD +
    Buffer.byteLength(SUMMARY_SYSTEM) +
    Buffer.byteLength(instructions ?? '') +
    Math.max(Buffer.byteLength(previousSummary ?? ''), summaryMaxTokens(budget) * 4);
  const chunkUnits = budget.units - fixed;
  if (chunkUnits < MIN_CHUNK_UNITS)
    throw validationFailed('The model’s input limit is too small to summarise this conversation');
  return chunkUnits;
}

type Tally = {
  inputTokens: number;
  outputTokens: number;
  /** Calls that returned. */
  calls: number;
  /** Whether any call was made, even one that then failed. */
  started: boolean;
  complete: boolean;
};

/**
 * The summary: the previous summary carried forward, updated with each chunk
 * of transcript in turn. One call for any ordinary backlog.
 */
async function summarize(
  plan: CompactionPlan,
  model: SummaryModel,
  instructions: string | null | undefined,
  tally: Tally,
): Promise<string> {
  const maxOutputTokens = summaryMaxTokens(contextBudget(model));
  let summary = plan.previous?.summary ?? null;
  const chunkUnits = summaryChunkUnits(model, summary, instructions);
  const turns = groupTurns(plan.summarized, () => 0)
    .map((group) => serializeConversation(group.messages))
    .filter((text) => text.length > 0);
  const { chunks } = chunkTranscript(turns, chunkUnits);
  if (!chunks.length) return summary ?? 'The earlier messages contained no text.';
  for (const transcript of chunks) {
    tally.started = true;
    const result = await generateText({
      model: model.languageModel,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt({ transcript, previousSummary: summary, instructions }),
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    tally.calls++;
    const { inputTokens, outputTokens } = result.totalUsage;
    if (inputTokens == null || outputTokens == null) tally.complete = false;
    tally.inputTokens += inputTokens ?? 0;
    tally.outputTokens += outputTokens ?? 0;
    const text = result.text.trim();
    if (!text) throw new Error('The model returned an empty summary');
    summary = text;
  }
  return summary!;
}

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
async function runCompaction(
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
  const [turns] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, input.threadId),
        eq(schema.message.userId, input.user.id),
        eq(schema.message.role, 'user'),
        previous ? gte(schema.message.position, previous.firstKeptPosition) : undefined,
      ),
    );
  if (Number(turns?.count ?? 0) < 2) throw validationFailed(NOTHING_TO_COMPACT);
  summaryChunkUnits(input.model, previous?.summary ?? null, input.instructions);
  if (await allowanceSpent(input.user, input.model.slug))
    throw quotaExceeded(
      'Your usage allowance is used up, so earlier messages cannot be summarised now.',
    );
}

/** The model of the conversation's latest reply, for compacting without a choice. */
export async function latestReplyModel(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ modelSlug: schema.message.modelSlug })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, threadId),
        eq(schema.message.role, 'assistant'),
        activeMessage(),
        sql`${schema.message.modelSlug} is not null`,
      ),
    )
    .orderBy(desc(schema.message.position), desc(schema.message.createdAt))
    .limit(1);
  return row?.modelSlug ?? null;
}
