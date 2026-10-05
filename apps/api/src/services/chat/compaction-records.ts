import { and, desc, eq, schema, sql } from '@oci/db';
import type { ConversationCompaction } from '@oci/shared';
import { db } from '../../db/index.js';
import { getSetting } from '../settings.js';
import { activeMessage } from './reply-path.js';

type CompactionRow = typeof schema.conversationCompaction.$inferSelect;
/** The compaction in use, with the position its kept messages start at. */
export type ActiveCompaction = CompactionRow & { firstKeptPosition: number };

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
