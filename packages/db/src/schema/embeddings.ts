import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { pgTable } from './_table.js';
import { attachment } from './chat.js';

/**
 * Project files whose passages could not be embedded with the current
 * embeddings model (migration 0029), so the background job backs off instead
 * of retrying them every tick. A row only applies while `model_key` is the
 * configured model: changing the model gives every file a fresh start. The
 * row is removed once the file's passages are embedded, and goes with the file.
 *
 * The embeddings themselves live in `project_file_embedding`, which is not
 * part of any migration: its `vector(n)` column needs the pgvector extension,
 * which an operator enables, and its size depends on the model. OCI creates it
 * at runtime (see apps/api/src/services/embeddings/storage.ts).
 */
export const projectFileEmbeddingFailure = pgTable(
  'project_file_embedding_failure',
  {
    attachmentId: text('attachment_id')
      .primaryKey()
      .references(() => attachment.id, { onDelete: 'cascade' }),
    modelKey: text('model_key').notNull(),
    failures: integer('failures').notNull().default(1),
    lastError: text('last_error'),
    retryAt: timestamp('retry_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_file_embedding_failure_retry_idx').on(t.retryAt),
    check('project_file_embedding_failure_failures', sql`${t.failures} > 0`),
    check('project_file_embedding_failure_error_length', sql`char_length(${t.lastError}) <= 500`),
  ],
);
