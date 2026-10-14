import type { BackgroundMigrationDefinition } from './types.js';

export const CHUNK_SEARCH_FOLDED = '0.13.chunk-search-folded';

/**
 * Fills `project_file_chunk.search_folded` for the chunks written before
 * migration 0049 (#362, SPEC-accent-search.md). The trigger of 0049 keeps it
 * for everything written since, so this only ever touches old rows.
 *
 * The table's key is (attachment_id, ordinal), so each batch walks it in that
 * order with a cursor of `attachment_id|ordinal`, compared in SQL as a row.
 * Chunks whose text has letters the fold changes get the folded vector (the
 * same SQL function the trigger calls), computed from the row's own column
 * inside the UPDATE so a chunk replaced mid-batch keeps its latest text's
 * vector. Idempotent and resumable: a chunk that already has its vector is
 * skipped.
 *
 * Project search reads the column only once this is done
 * (`isBackgroundMigrationDone`); until then it searches exactly as v0.12 did.
 */
export const chunkSearchFolded: BackgroundMigrationDefinition = {
  name: CHUNK_SEARCH_FOLDED,
  release: '0.13.0',
  table: 'public.project_file_chunk',
  description:
    'Stores the accent-folded search text of older project file passages, so a search for "bibliotheque" finds "bibliothèque" in files indexed before 0.13.',
  batchSize: 500,
  pauseMs: 200,
  async batch(sql, { cursor, batchSize }) {
    const separator = cursor === null ? -1 : cursor.lastIndexOf('|');
    const after =
      cursor === null || separator < 0
        ? null
        : {
            attachmentId: cursor.slice(0, separator),
            ordinal: Number(cursor.slice(separator + 1)),
          };
    const batch = await sql<{ attachment_id: string; ordinal: number }[]>`
      select attachment_id, ordinal from project_file_chunk
      where ${
        after === null
          ? sql`true`
          : sql`(attachment_id, ordinal) > (${after.attachmentId}, ${after.ordinal}::integer)`
      }
      order by attachment_id, ordinal
      limit ${batchSize}
    `;
    const lastRow = batch.at(-1);
    const last = lastRow ? `${lastRow.attachment_id}|${lastRow.ordinal}` : cursor;
    if (!lastRow) return { cursor: last, rows: 0, done: true };
    await sql`
      update project_file_chunk c
      set search_folded = oci_chunk_folded_vector(c.content)
      from (
        select * from unnest(
          ${batch.map((row) => row.attachment_id)}::text[],
          ${batch.map((row) => row.ordinal)}::integer[]
        ) as given(attachment_id, ordinal)
      ) b
      where c.attachment_id = b.attachment_id
        and c.ordinal = b.ordinal
        and c.search_folded is null
        and oci_chunk_folded_vector(c.content) is not null
    `;
    return { cursor: last, rows: batch.length, done: batch.length < batchSize };
  },
};
