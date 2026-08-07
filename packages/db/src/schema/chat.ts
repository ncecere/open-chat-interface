import type { ReasoningEffort } from '@oci/shared';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

export const persona = pgTable(
  'persona',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    systemPrompt: text('system_prompt').notNull().default(''),
    traits: jsonb('traits').$type<string[]>().notNull().default([]),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index('persona_user_idx').on(t.userId),
    uniqueIndex('persona_user_default_unique').on(t.userId).where(sql`${t.isDefault}`),
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
    personaId: text('persona_id').references(() => persona.id, { onDelete: 'set null' }),
    temporary: boolean('temporary').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('thread_user_updated_idx').on(t.userId, t.updatedAt),
    index('thread_parent_idx').on(t.parentThreadId),
    index('thread_temporary_expiry_idx').on(t.temporary, t.expiresAt),
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
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    durationMs: integer('duration_ms'),
    ...timestamps(),
  },
  (t) => [
    index('message_thread_position_idx').on(t.threadId, t.position),
    index('message_parent_idx').on(t.parentMessageId),
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
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    thumbnailKey: text('thumbnail_key'),
    /** Text extracted from PDFs and documents for model context. */
    extractedText: text('extracted_text'),
    ...timestamps(),
  },
  (t) => [
    index('attachment_user_idx').on(t.userId),
    index('attachment_message_idx').on(t.messageId),
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
