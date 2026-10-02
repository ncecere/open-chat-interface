import { sql } from 'drizzle-orm';
import { check, index, integer, text } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { message, thread } from './chat.js';

export type CompactionReason = 'automatic' | 'manual' | 'overflow';

/**
 * A summary of a conversation's earlier turns (migration 0028). The model is
 * sent the newest row's summary plus the messages from `firstKeptMessageId`
 * on; older messages stay stored, visible, exported and shared, but are not
 * sent. Rows cascade with their thread, owner and first kept message.
 */
export const conversationCompaction = pgTable(
  'conversation_compaction',
  {
    id: primaryId(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Always a user message: the start of the first turn sent verbatim. */
    firstKeptMessageId: text('first_kept_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    reason: text('reason').$type<CompactionReason>().notNull(),
    /** Every message before the cut, including those an earlier summary covered. */
    messagesSummarized: integer('messages_summarized').notNull(),
    /** Estimated size of what this summary replaced (previous summary plus turns). */
    tokensSummarized: integer('tokens_summarized').notNull(),
    modelSlug: text('model_slug').notNull(),
    /** What the summary call used; null when the provider did not report it. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    ...timestamps(),
  },
  (t) => [
    index('conversation_compaction_thread_idx').on(t.threadId, t.createdAt),
    index('conversation_compaction_message_idx').on(t.firstKeptMessageId),
    index('conversation_compaction_user_idx').on(t.userId),
    check(
      'conversation_compaction_reason',
      sql`${t.reason} in ('automatic', 'manual', 'overflow')`,
    ),
    check(
      'conversation_compaction_summary_length',
      sql`char_length(${t.summary}) between 1 and 200000`,
    ),
    check(
      'conversation_compaction_counts',
      sql`${t.messagesSummarized} >= 0 and ${t.tokensSummarized} >= 0`,
    ),
  ],
);
