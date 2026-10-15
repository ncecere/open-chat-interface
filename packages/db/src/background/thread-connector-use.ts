import type { BackgroundMigrationDefinition } from './types.js';

export const THREAD_CONNECTOR_USE = '0.14.thread-connector-use';

/**
 * Fills `thread_connector_use` for conversations that used a connector's tools
 * before migration 0052, or on a v0.13 replica during the rolling upgrade
 * (#395, SPEC-data-classification.md). From 0.14 on, OCI records a use before
 * every connector tool runs, in every mode; this finds the uses of earlier
 * releases in the stored messages, so that classifying a connector later
 * reaches the conversations that used it earlier.
 *
 * A tool part is `tool-mcp__<slug>__<tool>` (or a `dynamic-tool` part whose
 * `toolName` is that id). The slug names the connector. A slug reused after
 * its connector was deleted and created again over-labels, which is the safe
 * direction; a connector deleted before this runs has nothing to attach to
 * (its classes, if any, were frozen onto the conversations by trigger when it
 * was deleted, or it never carried any).
 *
 * Each batch takes the next messages in key order and inserts the uses found
 * in them. Idempotent and resumable: an existing row is left alone (insert on
 * conflict do nothing), so a batch whose commit was lost to a failover is just
 * run again, and a use recorded live while it runs is kept. Rows written after
 * `migrate --post` schedules this need nothing from it: release 0.14's own code
 * records them. Until it has finished, a decision also scans the conversation's
 * own messages (apps/api resolve.ts), so nothing waits for it.
 */
export const threadConnectorUse: BackgroundMigrationDefinition = {
  name: THREAD_CONNECTOR_USE,
  release: '0.14.0',
  table: 'public.message',
  description:
    'Finds the conversations that used a connector before 0.14, so that classifying the connector reaches them.',
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
      insert into thread_connector_use (thread_id, connector_id, first_used_at)
      select used.thread_id, connector.id, used.first_used_at
      from (
        select m.thread_id,
               split_part(
                 case when p->>'type' = 'dynamic-tool' then p->>'toolName' else substr(p->>'type', 6) end,
                 '__', 2
               ) as slug,
               min(m.created_at) as first_used_at
        from message m
        cross join lateral jsonb_array_elements(m.parts) as p
        where m.id = any(${batch.map((row) => row.id)}::text[])
          and m.role = 'assistant'
          and jsonb_typeof(m.parts) = 'array'
          and jsonb_path_exists(
            m.parts,
            '$[*] ? (@.type starts with "tool-mcp__" || (@.type == "dynamic-tool" && @.toolName starts with "mcp__"))'
          )
          and (
            (p->>'type') like 'tool-mcp\_\_%'
            or ((p->>'type') = 'dynamic-tool' and (p->>'toolName') like 'mcp\_\_%')
          )
        group by 1, 2
      ) used
      join connector on connector.slug = used.slug
      on conflict do nothing
    `;
    return { cursor: last, rows: batch.length, done: batch.length < batchSize };
  },
};
