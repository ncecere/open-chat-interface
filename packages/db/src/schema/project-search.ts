import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { pgTable } from './_table.js';
import { attachment } from './chat.js';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Whether a project file's extracted text has been split into chunks, and how
 * many it produced (migration 0026). A file with no row has not been indexed
 * yet: the upload indexes it straight away, and the `projects.index-files` job
 * picks up anything that missed that, such as files added before v0.8. A row
 * with `chunk_count = 0` means the file has no text to search (an image, or a
 * document nothing could be extracted from).
 *
 * Inserting this row is the claim on indexing a file, so concurrent indexers
 * never write a file's chunks twice. It goes with the file (ON DELETE CASCADE).
 */
export const projectFileIndex = pgTable(
  'project_file_index',
  {
    attachmentId: text('attachment_id')
      .primaryKey()
      .references(() => attachment.id, { onDelete: 'cascade' }),
    chunkCount: integer('chunk_count').notNull(),
    /** True when the text needed more chunks than the per-file cap allows. */
    truncated: boolean('truncated').notNull().default(false),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('project_file_index_chunk_count', sql`${t.chunkCount} between 0 and 2000`)],
);

/**
 * One overlapping passage of a project file's extracted text, with a stored
 * 'simple' full-text vector (the configuration conversation search uses).
 * Offsets are JavaScript string indices into the extracted text, and
 * `content` is exactly the text between them. Chunks go with their file, and
 * so with its project and its owner, through ON DELETE CASCADE.
 */
export const projectFileChunk = pgTable(
  'project_file_chunk',
  {
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => attachment.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    content: text('content').notNull(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, "content")`),
  },
  (t) => [
    primaryKey({ name: 'project_file_chunk_pk', columns: [t.attachmentId, t.ordinal] }),
    index('project_file_chunk_search_idx').using('gin', t.search),
    check('project_file_chunk_ordinal', sql`${t.ordinal} >= 0 and ${t.ordinal} < 2000`),
    check(
      'project_file_chunk_offsets',
      sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`,
    ),
    check('project_file_chunk_content_length', sql`char_length(${t.content}) <= 4000`),
  ],
);
