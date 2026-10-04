import type { ReasoningEffort } from '@oci/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

/**
 * A person's project: conversations grouped under shared instructions and
 * files. Deleting a project never deletes its conversations; they are detached
 * (`thread.project_id` is set null). Its files are attachments with
 * `attachment.project_id` set, which cascade away with it so the attachment
 * delete triggers release storage and queue the blobs (migration 0024).
 */
export const project = pgTable(
  'project',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Added to the system prompt of every conversation in the project. */
    instructions: text('instructions').notNull().default(''),
    ...timestamps(),
  },
  (t) => [
    index('project_user_idx').on(t.userId, t.updatedAt),
    check('project_name_length', sql`char_length(${t.name}) between 1 and 100`),
    check('project_instructions_length', sql`char_length(${t.instructions}) <= 8000`),
  ],
);

export const thread = pgTable(
  'thread',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New Chat'),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    /** Set when this thread was created by branching an existing message. */
    parentThreadId: text('parent_thread_id'),
    branchedFromMessageId: text('branched_from_message_id'),
    temporary: boolean('temporary').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /**
     * Trash state. A soft-deleted thread is invisible everywhere a live thread
     * would appear and its share links are revoked, but it stays restorable
     * until the grace window elapses and the purge job removes it for good.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Why it was deleted, so the trash UI can explain automatic removals. */
    deletedReason: text('deleted_reason').$type<'user' | 'retention' | 'admin'>(),
    /** Set on conversations imported from another service; null otherwise. */
    importSource: text('import_source').$type<'chatgpt' | 'claude'>(),
    /** The source's conversation id, which makes re-importing idempotent. */
    importSourceId: text('import_source_id'),
    /** Null when the conversation is in no project, including after its project is deleted. */
    projectId: text('project_id').references(() => project.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    index('thread_user_updated_idx').on(t.userId, t.updatedAt),
    index('thread_project_idx').on(t.projectId, t.updatedAt).where(sql`${t.projectId} is not null`),
    uniqueIndex('thread_import_source_unique')
      .on(t.userId, t.importSource, t.importSourceId)
      .where(sql`${t.importSourceId} is not null`),
    index('thread_parent_idx').on(t.parentThreadId),
    index('thread_temporary_expiry_idx').on(t.temporary, t.expiresAt),
    index('thread_deleted_idx').on(t.deletedAt),
    // Conversations created since a date (the usage page's Overview tab, the
    // admin overview). Post-deploy step 0006 builds it with `INCLUDE
    // (temporary, parent_thread_id)` so the Overview tab's counts are
    // index-only; Drizzle cannot declare included columns.
    index('thread_created_at_idx').on(t.createdAt),
  ],
);

export const message = pgTable(
  'message',
  {
    id: primaryId(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant' | 'system'>().notNull(),
    /** AI SDK UIMessage parts array. */
    parts: jsonb('parts').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Linear ordering within a thread. */
    position: integer('position').notNull().default(0),
    /** Edit/branch lineage inside a single thread. */
    parentMessageId: text('parent_message_id'),
    modelSlug: text('model_slug'),
    effort: text('effort').$type<ReasoningEffort>(),
    webSearchUsed: boolean('web_search_used').notNull().default(false),
    status: text('status')
      .$type<'streaming' | 'complete' | 'error' | 'cancelled'>()
      .notNull()
      .default('complete'),
    errorMessage: text('error_message'),
    /**
     * Set on an assistant reply that a retry (or a switch between replies)
     * replaced. Each user turn has several stored replies but exactly one with
     * this null; model context, exports, shares and search follow only those
     * (migration 0025). Usage accounting still counts every generated reply.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    durationMs: integer('duration_ms'),
    /**
     * Change order for the compliance export (migration 0034): a trigger sets
     * it from a sequence on insert and whenever parts, status, error or
     * superseded time change. Null on messages written before v0.9.
     */
    changeSeq: bigint('change_seq', { mode: 'number' }),
    ...timestamps(),
  },
  (t) => [
    index('message_thread_position_idx').on(t.threadId, t.position),
    index('message_change_seq_idx').on(t.changeSeq).where(sql`${t.changeSeq} is not null`),
    index('message_parent_idx').on(t.parentMessageId),
    // Per-user message counts are read on every admin user listing. Without
    // this the count scans the whole table once per row returned, which at two
    // million messages takes the page from milliseconds to minutes.
    index('message_user_idx').on(t.userId),
    // The admin overview counts messages per day and the usage page counts
    // failed replies since a date. Built CONCURRENTLY by post-deploy step
    // 0001_message_created_at_index (`migrate --post`, v0.11), never by a
    // pre-deploy migration: building it in one blocks writes to `message`.
    index('message_created_at_idx').on(t.createdAt),
    // Failed replies since a date, for the usage page (post-deploy step 0002).
    index('message_error_created_at_idx').on(t.createdAt).where(sql`${t.status} = 'error'`),
    // The usage page's Overview tab counts sent messages, replies that searched
    // the web and cancelled replies since a date, each index-only from its own
    // partial index (post-deploy steps 0003, 0004 and 0005).
    index('message_sent_created_at_idx').on(t.createdAt).where(sql`${t.role} = 'user'`),
    index('message_web_search_created_at_idx').on(t.createdAt).where(sql`${t.webSearchUsed}`),
    index('message_cancelled_created_at_idx').on(t.createdAt).where(sql`${t.status} = 'cancelled'`),
    // Conversation search over `text` parts only (migration 0023). Queries
    // must use exactly this expression; see services/thread-search.ts.
    index('message_text_search_idx').using(
      'gin',
      sql`to_tsvector('simple'::regconfig, jsonb_path_query_array(${t.parts}, '$[*] ? (@.type == "text").text'::jsonpath))`,
    ),
  ],
);

export const attachment = pgTable(
  'attachment',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Null while an upload is staged and not yet sent. Once attached, the file
     * belongs to that message and dies with it: detaching instead would strand
     * the row and its blob forever, and would make an already-sent attachment
     * look unsent and therefore re-sendable.
     */
    messageId: text('message_id').references(() => message.id, { onDelete: 'cascade' }),
    /**
     * Set for a project file, which belongs to the project instead of a message
     * and dies with it. A file is never both (enforced by a check constraint).
     */
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Durable capacity reservation; hidden from clients until the blob is committed. */
    uploadPending: boolean('upload_pending').notNull().default(false),
    thumbnailKey: text('thumbnail_key'),
    /** Text extracted from PDFs and documents for model context. */
    extractedText: text('extracted_text'),
    /** Trash state; mirrors `thread.deletedAt`. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason').$type<'user' | 'retention' | 'admin' | 'thread'>(),
    ...timestamps(),
  },
  (t) => [
    index('attachment_user_idx').on(t.userId),
    index('attachment_message_idx').on(t.messageId),
    index('attachment_deleted_idx').on(t.deletedAt),
    index('attachment_project_idx').on(t.projectId).where(sql`${t.projectId} is not null`),
    check('attachment_single_owner', sql`${t.projectId} is null or ${t.messageId} is null`),
  ],
);

export const shareLink = pgTable(
  'share_link',
  {
    id: primaryId(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    /** Snapshot up to this message; null means the live thread. */
    upToMessageId: text('up_to_message_id'),
    viewCount: integer('view_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('share_link_slug_unique').on(t.slug),
    index('share_link_thread_idx').on(t.threadId),
  ],
);
