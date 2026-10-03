import { desc, eq, schema } from '@oci/db';
import type { db } from '../../db/index.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A fork or edit copies the source's compaction when its cut lies within the
 * copied messages: the newest compaction whose first kept message was copied.
 * Its summary covers only messages before that cut, which were all copied too.
 * The copy cost nothing, so it carries no usage of its own.
 *
 * `copied` maps each source message id to its copy in the new thread.
 */
export async function copyCompactionToFork(
  tx: Transaction,
  input: { sourceThreadId: string; threadId: string; userId: string; copied: Map<string, string> },
) {
  const rows = await tx
    .select()
    .from(schema.conversationCompaction)
    .where(eq(schema.conversationCompaction.threadId, input.sourceThreadId))
    .orderBy(desc(schema.conversationCompaction.createdAt), desc(schema.conversationCompaction.id));
  const usable = rows.find((row) => input.copied.has(row.firstKeptMessageId));
  if (!usable) return;
  await tx.insert(schema.conversationCompaction).values({
    threadId: input.threadId,
    userId: input.userId,
    firstKeptMessageId: input.copied.get(usable.firstKeptMessageId)!,
    summary: usable.summary,
    reason: usable.reason,
    messagesSummarized: usable.messagesSummarized,
    tokensSummarized: usable.tokensSummarized,
    modelSlug: usable.modelSlug,
    createdAt: usable.createdAt,
  });
}
