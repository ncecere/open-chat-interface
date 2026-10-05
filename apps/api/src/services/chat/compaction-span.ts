import { and, desc, eq, gte, inArray, isNull, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { isImage } from '../attachments/validate.js';
import { groupTurns, selectCutPoint, softThresholdUnits, withSummary } from './compaction-plan.js';
import type { ActiveCompaction } from './compaction-records.js';
import {
  IMAGE_INPUT_UNITS,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  messageCost,
  textCost,
} from './context-budget.js';
import { boundedParts, payloadBytes } from './context-history.js';
import { historyParts } from './message-parts.js';
import { activeMessage } from './reply-path.js';

type SpanMessage = { id: string; role: 'user' | 'assistant'; parts: unknown };

/** Messages read for one compaction: newest first, then trimmed to these bounds. */
const MAX_SPAN_MESSAGES = 2000;
const MAX_SPAN_BYTES = 8 * 1024 * 1024;

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
 * the cut would not move past the previous one, or when `dueAboveUnits` is
 * given and the history the model would receive (the previous summary plus
 * the turns since its cut) is not above it nor near the history ceilings.
 */
export async function planCompaction(input: {
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
