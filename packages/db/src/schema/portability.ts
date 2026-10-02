import { bigint, index, integer, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

export interface ConversationImportDetails {
  /** Detected export layout, such as `v1` or `v2`. */
  formatVersion?: string;
  /** Content or block types the importer did not recognise, with counts. */
  unknownContentTypes?: Record<string, number>;
  /** Non-fatal problems worth showing, such as a truncated download. */
  warnings?: string[];
}

/**
 * One uploaded ChatGPT or Claude export and its processing state.
 *
 * The upload stays in object storage until processing finishes, so a restart
 * resumes from the stored file. A delete trigger queues any upload still held
 * when the row disappears, including through an account-deletion cascade.
 */
export const conversationImport = pgTable(
  'conversation_import',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: text('source').$type<'chatgpt' | 'claude' | 'unknown'>().notNull().default('unknown'),
    status: text('status')
      .$type<'pending' | 'running' | 'completed' | 'failed'>()
      .notNull()
      .default('pending'),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /** Null once processing has finished and the upload has been released. */
    storageKey: text('storage_key'),
    importedCount: integer('imported_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    /** Claims so far; a repeatedly crashing import eventually fails. */
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    details: jsonb('details').$type<ConversationImportDetails>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('conversation_import_user_idx').on(t.userId, t.createdAt),
    index('conversation_import_status_idx').on(t.status, t.updatedAt),
  ],
);
