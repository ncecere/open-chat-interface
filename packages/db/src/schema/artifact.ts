import type { ArtifactKind, ArtifactVersionSource } from '@oci/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { message, thread } from './chat.js';

/**
 * A versioned artifact (migration 0032): an HTML page, SVG image, Mermaid
 * diagram or Markdown document kept as an object of its own. It belongs to
 * the conversation and the reply that created it, and cascades with the
 * thread, its owner and that reply. `sourceKey` says where it came from
 * (`block:<n>`, a fenced block of the reply, or `tool:<call id>`), so
 * detection and tool calls are idempotent.
 */
export const artifact = pgTable(
  'artifact',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    title: text('title').notNull(),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('artifact_message_source_unique').on(t.messageId, t.sourceKey),
    index('artifact_thread_idx').on(t.threadId, t.createdAt),
    index('artifact_user_idx').on(t.userId),
    check('artifact_kind', sql`${t.kind} in ('html', 'svg', 'mermaid', 'markdown')`),
    check('artifact_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('artifact_source_key_length', sql`char_length(${t.sourceKey}) between 1 and 300`),
    check('artifact_current_version', sql`${t.currentVersion} >= 1`),
  ],
);

/**
 * One version of an artifact. Versions are never changed; a change makes a
 * new one. Made by a reply (`message_id`, set null if that message is ever
 * deleted) or by the person editing a document. `size_bytes` (UTF-8) counts
 * towards the owner's storage while the conversation is not in the trash.
 */
export const artifactVersion = pgTable(
  'artifact_version',
  {
    id: primaryId(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    source: text('source').$type<ArtifactVersionSource>().notNull(),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('artifact_version_unique').on(t.artifactId, t.version),
    index('artifact_version_message_idx').on(t.messageId),
    check('artifact_version_number', sql`${t.version} >= 1`),
    check('artifact_version_source', sql`${t.source} in ('reply', 'person')`),
    // Backstop for the 512 KiB limit enforced (with a clear message) in code.
    check(
      'artifact_version_size',
      sql`${t.sizeBytes} >= 0 and ${t.sizeBytes} <= 524288 and octet_length(${t.content}) = ${t.sizeBytes}`,
    ),
  ],
);
