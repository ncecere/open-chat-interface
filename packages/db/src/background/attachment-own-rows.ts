import { sql as query } from 'drizzle-orm';
import { ATTACHMENT_OWN_ROWS, runOwnRows } from '../attachment-copies.js';
import type { BackgroundMigrationDefinition } from './types.js';

/**
 * Gives every fork and edit that shares a file with the conversation it was
 * made from a row of its own for it (#358; docs/dev/database.md,
 * "Files in forks and edits").
 *
 * Each batch walks the next messages in key order and, for those that show a
 * file belonging to another message of the same person, inserts a row for the
 * message (the same stored object), counts it in the person's storage and
 * points the message's part at it, in the batch's transaction. Idempotent: a
 * message that already owns the files it shows has nothing to convert, so a
 * batch whose commit was lost is simply run again.
 *
 * Release 0.11's own code gives forks and edits their own rows, so messages
 * written after the upgrade need nothing; until this finishes, the purge paths
 * give the descendants of what they delete their rows first
 * (`isBackgroundMigrationDone('0.11.attachment-own-rows')`).
 */
export const attachmentOwnRows: BackgroundMigrationDefinition = {
  name: ATTACHMENT_OWN_ROWS,
  release: '0.11.0',
  table: 'public.message',
  description:
    'Gives forks and edits made before 0.11 their own copy of the files they share with the conversation they came from, so deleting one no longer removes the files of the other.',
  batchSize: 1_000,
  pauseMs: 100,
  async batch(sql, { cursor, batchSize }) {
    const batch = await sql<{ id: string }[]>`
      select id from message
      where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
      order by id
      limit ${batchSize}
    `;
    const last = batch.at(-1)?.id ?? cursor;
    if (batch.length === 0) return { cursor: last, rows: 0, done: true };
    const ids = query.join(
      batch.map((row) => query`${row.id}`),
      query`, `,
    );
    await runOwnRows(sql, query`select unnest(array[${ids}]::text[])`);
    return { cursor: last, rows: batch.length, done: batch.length < batchSize };
  },
};
