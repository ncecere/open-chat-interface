import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, notInArray, schema, sql } from '@oci/db';
import type { CompactionReason, ConversationCompaction, UserRole } from '@oci/shared';
import { generateText } from 'ai';
import { db } from '../../db/index.js';
import { AppError, conflict, providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isImage } from '../attachments/validate.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  releaseReservation,
  reserveQuota,
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
  summaryPrompt,
} from './compaction-plan.js';
import { contextBudget, IMAGE_INPUT_UNITS, messageCost } from './context-budget.js';
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
 */

type CompactionRow = typeof schema.conversationCompaction.$inferSelect;
/** The compaction in use, with the position its kept messages start at. */
export type ActiveCompaction = CompactionRow & { firstKeptPosition: number };
type SummaryModel = Pick<
  TurnContext['resolved'],
  'slug' | 'languageModel' | 'contextWindow' | 'maxOutputTokens'
>;
type SpanMessage = { id: string; role: 'user' | 'assistant'; parts: unknown };
/** A stored message's place in the thread, for "before this message" bounds. */
export type MessageBound = { position: number; createdAt: Date; id: string };

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
 * The active-path messages from the previous cut (or the start) up to, not
 * including, `before`. Bounded like model context: newest first, so a backlog
 * too large to read loses its oldest messages, never the recent ones.
 */
async function loadSpan(input: {
  threadId: string;
  userId: string;
  fromPosition: number | null;
  before: MessageBound | null;
  excludeIds: string[];
}) {
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
        input.excludeIds.length ? notInArray(schema.message.id, input.excludeIds) : undefined,
        input.before
          ? sql`(${schema.message.position}, ${schema.message.createdAt}, ${schema.message.id})
      < (${input.before.position}, ${input.before.createdAt.toISOString()}::timestamptz, ${input.before.id})`
          : undefined,
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
  if (!ids.length) return [];
  const rows = await db
    .select({ id: schema.message.id, role: schema.message.role, parts: boundedParts })
    .from(schema.message)
    .where(and(inArray(schema.message.id, ids), eq(schema.message.threadId, input.threadId)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.reverse().flatMap((id) => {
    const row = byId.get(id);
    return row ? [row as SpanMessage] : [];
  });
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

export type CompactionPlan = {
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
 * the cut would not move past the previous one.
 */
export async function planCompaction(input: {
  threadId: string;
  userId: string;
  previous: ActiveCompaction | null;
  before: MessageBound | null;
  excludeIds: string[];
  keepUnits: number;
  atMostHalf?: boolean;
}): Promise<CompactionPlan | null> {
  const messages = await loadSpan({
    threadId: input.threadId,
    userId: input.userId,
    fromPosition: input.previous?.firstKeptPosition ?? null,
    before: input.before,
    excludeIds: input.excludeIds,
  });
  const files = await attachmentUnits(messages.map((message) => message.id));
  const groups = groupTurns(
    messages,
    (message) =>
      messageCost({ id: message.id, role: message.role, parts: historyParts(message.parts, true) })
        .units + (files.get(message.id) ?? 0),
  );
  const total = groups.reduce((sum, group) => sum + group.units, 0);
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
export async function summarize(
  plan: CompactionPlan,
  model: SummaryModel,
  instructions: string | null | undefined,
  tally: Tally,
): Promise<string> {
  const budget = contextBudget(model);
  const maxOutputTokens = summaryMaxTokens(budget);
  let summary = plan.previous?.summary ?? null;
  const fixed =
    SUMMARY_PROMPT_OVERHEAD +
    Buffer.byteLength(SUMMARY_SYSTEM) +
    Buffer.byteLength(instructions ?? '') +
    Math.max(Buffer.byteLength(summary ?? ''), maxOutputTokens * 4);
  const chunkUnits = budget.units - fixed;
  if (chunkUnits < MIN_CHUNK_UNITS)
    throw validationFailed('The model’s input limit is too small to summarise this conversation');
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

async function modelPricing(slug: string) {
  const [row] = await db
    .select({
      inputPriceMicros: schema.model.inputPriceMicros,
      outputPriceMicros: schema.model.outputPriceMicros,
    })
    .from(schema.model)
    .where(
      and(
        eq(schema.model.organizationId, await getDefaultOrganizationId()),
        eq(schema.model.slug, slug),
      ),
    )
    .limit(1);
  return {
    inputPriceMicros: row?.inputPriceMicros ?? null,
    outputPriceMicros: row?.outputPriceMicros ?? null,
  };
}

/**
 * The summary call is its own usage event (no message counted), with the
 * compaction's id. A manual compaction is admitted like a reply and refused
 * when the person's allowance is spent; one made during a reply belongs to a
 * turn that was already admitted, so it is recorded without a second check.
 */
async function openUsage(
  user: { id: string; role: UserRole },
  modelSlug: string,
  id: string,
  admitted: boolean,
): Promise<UsageReservation> {
  if (admitted)
    return reserveQuotaForRun({
      userId: user.id,
      role: user.role,
      modelSlug,
      runId: id,
      messageCount: 0,
    });
  return reserveQuota({
    userId: user.id,
    role: user.role,
    modelSlug,
    runId: id,
    messageCount: 0,
    policies: [],
    pricing: await modelPricing(modelSlug),
    reserve: { costMicros: 0, tokens: 0 },
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

/** Records the compaction unless another one was recorded since the plan was made. */
async function commitCompaction(
  values: typeof schema.conversationCompaction.$inferInsert,
  previousId: string | null,
): Promise<ActiveCompaction | null> {
  return db.transaction(async (tx) => {
    await lockChatThread(tx, values.threadId, values.userId);
    const [latest] = await tx
      .select({ id: schema.conversationCompaction.id })
      .from(schema.conversationCompaction)
      .where(eq(schema.conversationCompaction.threadId, values.threadId))
      .orderBy(
        desc(schema.conversationCompaction.createdAt),
        desc(schema.conversationCompaction.id),
      )
      .limit(1);
    if ((latest?.id ?? null) !== previousId) return null;
    const [kept] = await tx
      .select({ position: schema.message.position })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, values.firstKeptMessageId),
          eq(schema.message.threadId, values.threadId),
        ),
      );
    if (!kept) return null;
    const [row] = await tx
      .insert(schema.conversationCompaction)
      .values({ ...values, createdAt: new Date() })
      .returning();
    return { ...row!, firstKeptPosition: kept.position };
  });
}

/** Summarise, account for the call, and record. Null when another compaction won. */
async function runCompaction(
  plan: CompactionPlan,
  options: {
    user: { id: string; role: UserRole };
    threadId: string;
    model: SummaryModel;
    reason: CompactionReason;
    instructions?: string | null;
    admitted: boolean;
  },
): Promise<ActiveCompaction | null> {
  const id = randomUUID();
  const reservation = await openUsage(options.user, options.model.slug, id, options.admitted);
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
    plan.previous?.id ?? null,
  );
}

/**
 * Compaction during a reply (automatic, or after the provider reported the
 * input too long). Best effort: on any failure the reply goes ahead without
 * it, leaving the oldest turns out as before. Returns the compaction now in
 * use when it changed, otherwise null.
 */
export async function compactForTurn(input: {
  context: Pick<TurnContext, 'user' | 'thread' | 'resolved'>;
  reason: Exclude<CompactionReason, 'manual'>;
  previous: ActiveCompaction | null;
  before: MessageBound | null;
  excludeIds: string[];
  keepUnits: number;
  atMostHalf?: boolean;
}): Promise<ActiveCompaction | null> {
  const { user, thread, resolved } = input.context;
  try {
    const plan = await planCompaction({
      threadId: thread.id,
      userId: user.id,
      previous: input.previous,
      before: input.before,
      excludeIds: input.excludeIds,
      keepUnits: input.keepUnits,
      atMostHalf: input.atMostHalf,
    });
    if (!plan) return null;
    const created = await runCompaction(plan, {
      user,
      threadId: thread.id,
      model: resolved,
      reason: input.reason,
      admitted: false,
    });
    // Another compaction was recorded meanwhile: use whichever is now newest.
    const current = created ?? (await latestCompaction(thread.id, user.id));
    return current && current.id !== input.previous?.id ? current : null;
  } catch (error) {
    logger.warn(
      { error, threadId: thread.id, reason: input.reason },
      'Compaction failed; the oldest turns are left out instead',
    );
    return null;
  }
}

/**
 * "Compact conversation": summarise now, with optional instructions. The
 * caller has checked ownership. Refused (409) while a reply is generating;
 * the summary call is admitted against the person's allowance.
 */
export async function compactThreadNow(
  user: { id: string; role: UserRole },
  threadId: string,
  input: { instructions?: string; model: SummaryModel },
): Promise<ActiveCompaction> {
  await db.transaction(async (tx) => {
    // The thread lock serialises this check with chat admission (claimThread).
    await lockChatThread(tx, threadId, user.id);
    const [active] = await tx
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.threadId, threadId),
          eq(schema.message.role, 'assistant'),
          eq(schema.message.status, 'streaming'),
        ),
      )
      .limit(1);
    if (active)
      throw conflict('Wait for the current reply to finish before compacting the conversation');
  });
  const previous = await latestCompaction(threadId, user.id);
  const plan = await planCompaction({
    threadId,
    userId: user.id,
    previous,
    before: null,
    excludeIds: [],
    keepUnits: Math.floor(contextBudget(input.model).units / 2),
    atMostHalf: true,
  });
  if (!plan) throw validationFailed(NOTHING_TO_COMPACT);
  let created: ActiveCompaction | null;
  try {
    created = await runCompaction(plan, {
      user,
      threadId,
      model: input.model,
      reason: 'manual',
      instructions: input.instructions,
      admitted: true,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.warn({ error, threadId }, 'Manual compaction failed');
    throw providerError('The model could not summarise this conversation. Try again.');
  }
  if (!created)
    throw conflict('The conversation changed while it was being summarised. Try again.');
  return created;
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
