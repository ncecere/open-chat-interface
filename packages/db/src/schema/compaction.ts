import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { message, thread } from './chat.js';

export type CompactionReason = 'automatic' | 'manual';

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
    check('conversation_compaction_reason', sql`${t.reason} in ('automatic', 'manual')`),
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

/**
 * A queued or running background compaction (migration 0028): at most one per
 * thread, so a repeated request is idempotent. Claimed by the job runner (or
 * an in-process kick) with `for update skip locked` and a lease; a lease that
 * runs out (the replica died) lets another worker take it over. Removed when
 * the work is done, given up, or its conversation is trashed.
 */
export const conversationCompactionJob = pgTable(
  'conversation_compaction_job',
  {
    threadId: text('thread_id')
      .primaryKey()
      .references(() => thread.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Manual wins over automatic when both are requested before it runs. */
    reason: text('reason').$type<CompactionReason>().notNull(),
    /** The conversation's (last used) model: it summarises and sizes the kept turns. */
    modelSlug: text('model_slug').notNull(),
    instructions: text('instructions'),
    status: text('status').$type<'pending' | 'running'>().notNull().default('pending'),
    /** Not claimed before this time: retries and an allowance that is spent wait. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    /** A running claim's end; after it another worker may take the job over. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** The running worker's claim: only it may finish or reschedule the row. */
    claimId: text('claim_id'),
    attempts: integer('attempts').notNull().default(0),
    /** Requested again while running: run once more when the current run ends. */
    rerun: boolean('rerun').notNull().default(false),
    /** When the latest manual request (or the first request) arrived. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('conversation_compaction_job_due_idx').on(t.status, t.runAfter),
    index('conversation_compaction_job_user_idx').on(t.userId),
    check('conversation_compaction_job_reason', sql`${t.reason} in ('automatic', 'manual')`),
    check('conversation_compaction_job_status', sql`${t.status} in ('pending', 'running')`),
    check(
      'conversation_compaction_job_instructions_length',
      sql`${t.instructions} is null or char_length(${t.instructions}) <= 2000`,
    ),
  ],
);
