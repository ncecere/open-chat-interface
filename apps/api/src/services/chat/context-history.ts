import { and, desc, eq, inArray, ne, schema, sql } from '@oci/db';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { MAX_HISTORY_BYTES, MAX_HISTORY_MESSAGES } from './context-budget.js';
import { regenerationContext } from './message-parts.js';

export type ContextMessage = Pick<typeof schema.message.$inferSelect, 'id' | 'role' | 'parts'>;
const payloadBytes = sql<number>`octet_length(${schema.message.parts}::text)`;
// A concurrent metadata change must not turn a bounded read into an oversized payload.
const boundedParts = sql<ContextMessage['parts']>`case when ${payloadBytes} <= ${MAX_HISTORY_BYTES}
  then ${schema.message.parts} else '[]'::jsonb end`;

/** Transcript pagination is separate. Model preparation never loads the whole thread. */
export async function loadContextHistory(input: {
  threadId: string;
  userId: string;
  claimId: string;
  latest: UIMessage;
  regenerate: boolean;
  attachmentIds: string[];
}) {
  let latest = input.latest;
  let target: (ContextMessage & { position: number; createdAt: Date; bytes: number }) | undefined;
  if (input.regenerate) {
    const [row] = await db
      .select({
        id: schema.message.id,
        role: schema.message.role,
        parts: boundedParts,
        position: schema.message.position,
        createdAt: schema.message.createdAt,
        bytes: payloadBytes,
      })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, latest.id),
          eq(schema.message.threadId, input.threadId),
          eq(schema.message.userId, input.userId),
          eq(schema.message.role, 'user'),
        ),
      )
      .limit(1);
    if (!row)
      throw validationFailed('The regeneration target must be a user message in this thread');
    if (row.bytes > MAX_HISTORY_BYTES)
      throw validationFailed('The regeneration target exceeds the input payload limit');
    target = row;
    latest = regenerationContext([row], latest, input.attachmentIds).latest;
  }
  const candidates = await db
    .select({
      id: schema.message.id,
      bytes: payloadBytes,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, input.threadId),
        eq(schema.message.userId, input.userId),
        ne(schema.message.id, input.claimId),
        inArray(schema.message.role, ['user', 'assistant']),
        target
          ? sql`(${schema.message.position}, ${schema.message.createdAt}, ${schema.message.id})
      < (${target.position}, ${target.createdAt.toISOString()}::timestamptz, ${target.id})`
          : undefined,
      ),
    )
    .orderBy(desc(schema.message.position), desc(schema.message.createdAt), desc(schema.message.id))
    .limit(MAX_HISTORY_MESSAGES + 1);
  const ids: string[] = [];
  let bytes = target?.bytes ?? 0;
  for (const row of candidates) {
    if (ids.length >= MAX_HISTORY_MESSAGES || bytes + row.bytes > MAX_HISTORY_BYTES) break;
    ids.push(row.id);
    bytes += row.bytes;
  }
  const rows = ids.length
    ? await db
        .select({
          id: schema.message.id,
          role: schema.message.role,
          parts: boundedParts,
          bytes: payloadBytes,
        })
        .from(schema.message)
        .where(
          and(
            inArray(schema.message.id, ids),
            eq(schema.message.threadId, input.threadId),
            eq(schema.message.userId, input.userId),
          ),
        )
    : [];
  if (
    rows.length !== ids.length ||
    rows.reduce((sum, row) => sum + row.bytes, target?.bytes ?? 0) > MAX_HISTORY_BYTES
  ) {
    throw validationFailed('Conversation context changed while preparing the reply. Try again.');
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    latest,
    target,
    history: ids.reverse().map((id) => byId.get(id)!),
    limited: ids.length !== candidates.length,
  };
}
