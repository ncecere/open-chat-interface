import type { BackgroundMigrationDefinition } from './types.js';

/**
 * Test only, and inert unless named in OCI_TEST_BACKGROUND_MIGRATIONS: rewrites
 * every message row with its own values (`updated_at = updated_at`, which the
 * compliance trigger ignores), a batch at a time in key order.
 *
 * v0.11 ships no real background migration yet. This one gives the job
 * runner, the live tests and the rolling-upgrade test real work of the right
 * shape: it takes row locks on the busiest table while replies are being
 * saved, writes WAL and is safe to repeat, so it exercises leases, throttling,
 * pausing, crashes and draining on a real dataset without changing any data.
 */
export const rewriteMessagesInPlace: BackgroundMigrationDefinition = {
  name: 'oci-test.rewrite-messages-in-place',
  release: 'test',
  table: 'public.message',
  description: 'Test only: rewrites every message with its own values.',
  batchSize: 1_000,
  pauseMs: 50,
  async batch(sql, { cursor, batchSize }) {
    const [row] = await sql<[{ rows: number; last: string | null }]>`
      with batch as (
        select id from message
        where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
        order by id
        limit ${batchSize}
      ),
      updated as (
        update message m set updated_at = m.updated_at
        from batch where m.id = batch.id
        returning m.id
      )
      select (select count(*) from updated)::integer as rows,
             (select id from batch order by id desc limit 1) as last
    `;
    const rows = row?.rows ?? 0;
    return { cursor: row?.last ?? cursor, rows, done: rows < batchSize };
  },
};

export const TEST_BACKGROUND_MIGRATIONS: readonly BackgroundMigrationDefinition[] = [
  rewriteMessagesInPlace,
];
