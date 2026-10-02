import { sql } from 'drizzle-orm';
import { check, index, text } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { message, thread } from './chat.js';

/** Who wrote a memory: the model through the `remember` tool, or the person in Settings. */
export type MemorySource = 'tool' | 'person';

/**
 * One note about a person that OCI includes in their system prompt (migration
 * 0033). Every entry belongs to exactly one person and cascades with them.
 * `threadId` and `messageId` record where a tool-made memory came from; they
 * are informational and become null when that conversation is deleted, so a
 * memory outlives the chat it was made in until the person deletes it.
 */
export const userMemory = pgTable(
  'user_memory',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    source: text('source').$type<MemorySource>().notNull(),
    threadId: text('thread_id').references(() => thread.id, { onDelete: 'set null' }),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('user_memory_user_idx').on(t.userId, t.updatedAt),
    index('user_memory_updated_idx').on(t.updatedAt),
    index('user_memory_thread_idx').on(t.threadId),
    index('user_memory_message_idx').on(t.messageId),
    check('user_memory_source', sql`${t.source} in ('tool', 'person')`),
    check('user_memory_content_length', sql`char_length(${t.content}) between 1 and 500`),
  ],
);
