import type { BackgroundMigrationDefinition } from './types.js';

export const MESSAGE_SEARCH_FOLDED = '0.13.message-search-folded';

/**
 * Fills `message.search_folded` for the messages written before migration 0048
 * (#362, SPEC-accent-search.md). The trigger of 0048 keeps it for everything
 * written since, so this only ever touches old rows.
 *
 * Each batch takes the next messages in key order and, for those whose text
 * has letters the fold changes, stores the folded vector (the same SQL
 * function the trigger calls). Idempotent and resumable: a row that already
 * has its vector is skipped, so a batch whose commit was lost to a failover is
 * simply run again. The vector is computed from the row's own column inside
 * the UPDATE, so a message edited while the batch runs gets the vector of its
 * latest text. Writing it does not change `change_seq` (the compliance export
 * sees no change) or any other column.
 *
 * Search uses the column only once this and post-deploy step
 * 0014_message_search_folded_index are both done
 * (`isBackgroundMigrationDone`, `isPostStepDone`); until then it searches
 * exactly as v0.12 did.
 */
export const messageSearchFolded: BackgroundMigrationDefinition = {
  name: MESSAGE_SEARCH_FOLDED,
  release: '0.13.0',
  table: 'public.message',
  description:
    'Stores the accent-folded search text of older messages, so a search for "bibliotheque" finds "bibliothèque" in conversations written before 0.13.',
  batchSize: 500,
  pauseMs: 200,
  async batch(sql, { cursor, batchSize }) {
    const batch = await sql<{ id: string }[]>`
      select id from message
      where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
      order by id
      limit ${batchSize}
    `;
    const last = batch.at(-1)?.id ?? cursor;
    if (batch.length === 0) return { cursor: last, rows: 0, done: true };
    await sql`
      update message
      set search_folded = oci_message_folded_vector(parts)
      where id = any(${batch.map((row) => row.id)}::text[])
        and search_folded is null
        and oci_message_folded_vector(parts) is not null
    `;
    return { cursor: last, rows: batch.length, done: batch.length < batchSize };
  },
};
