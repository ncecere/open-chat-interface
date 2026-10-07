import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';

/**
 * Files that conversations shared before each kept its own (#358).
 *
 * Until 0.11 a fork, and an edit that kept its file, copied a question's
 * `data-attachment` part as it was: the same attachment id in two
 * conversations, the file belonging to the one it was first sent in. Deleting
 * that conversation (trash, "Delete now", retention) deleted the row, and with
 * it the file the other conversation still showed. From now on every message
 * that shows a file has an attachment row of its own for it, pointing at the
 * same stored object (the delete trigger and the storage reaper delete the
 * object only when the last row using it is gone).
 *
 * `ownRowsStatement` gives the existing sharers their rows: for each message
 * among the candidates that carries a file belonging to another message of the
 * same person, it inserts a row for it (same object, name, type and extracted
 * text), counts it in the person's storage, and points the message's part at
 * the new id. One statement, so it is atomic whoever runs it: the background
 * migration (a batch of messages in key order) and the purge paths while that
 * migration is not finished (the descendants of the messages whose files are
 * about to be deleted).
 */

/** The background migration that gives existing forks and edits their own rows. */
export const ATTACHMENT_OWN_ROWS = '0.11.attachment-own-rows';

/** The path a stored file is served from; mirrors the part the chat route writes. */
const contentUrl = (id: SQL) => sql`'/api/attachments/' || ${id} || '/content'`;

/**
 * The statement, for the messages `candidateIds` selects (a query of one `id`
 * column). Returns one row: `copies` made and `messages` rewritten.
 *
 * What it leaves alone, deliberately:
 * - another person's file, a project file, an unfinished upload;
 * - a file the person removed (trashed or deleted on its own), which a
 *   conversation that shows it reports as removed. A file whose conversation
 *   is in the trash (`deleted_reason = 'thread'`) is not that: it is given
 *   to the sharer live, since the trash is what is about to end it;
 * - a part that names no row (the file is already gone).
 *
 * Source rows are locked `for share` in id order, so a delete of the original
 * either happens before (nothing to copy, the row is gone) or waits for this
 * statement to commit (the copy exists by then).
 */
export function ownRowsStatement(candidateIds: SQL): SQL {
  return sql`
    with cand as materialized (
      select m.id, m.thread_id, m.user_id, m.parts
      from message m
      where m.id in (${candidateIds})
        and m.role = 'user'
        and jsonb_typeof(m.parts) = 'array'
        and m.parts @> '[{"type": "data-attachment"}]'::jsonb
    ),
    refs as (
      select distinct c.id as message_id, c.thread_id, c.user_id,
        p.part #>> '{data,id}' as source_id
      from cand c
      cross join lateral jsonb_array_elements(c.parts) as p(part)
      where p.part ->> 'type' = 'data-attachment'
        and p.part #>> '{data,id}' is not null
    ),
    sources as (
      select a.*
      from attachment a
      where a.id in (select source_id from refs)
      order by a.id
      for share of a
    ),
    todo as materialized (
      select gen_random_uuid()::text as new_id, r.message_id, r.source_id, s.organization_id,
        s.user_id, s.filename, s.mime_type, s.size_bytes, s.storage_key, s.thumbnail_key,
        s.extracted_text, s.created_at, th.deleted_at as thread_deleted_at
      from refs r
      join sources s on s.id = r.source_id
      join thread th on th.id = r.thread_id
      where s.user_id = r.user_id
        and s.message_id is not null
        and s.message_id <> r.message_id
        and s.project_id is null
        and not s.upload_pending
        and s.storage_key <> 'pending'
        and (s.deleted_at is null or s.deleted_reason = 'thread')
    ),
    made as (
      insert into attachment (id, organization_id, user_id, message_id, filename, mime_type,
        size_bytes, storage_key, thumbnail_key, extracted_text, created_at, deleted_at,
        deleted_reason)
      select t.new_id, t.organization_id, t.user_id, t.message_id, t.filename, t.mime_type,
        t.size_bytes, t.storage_key, t.thumbnail_key, t.extracted_text, t.created_at,
        t.thread_deleted_at, case when t.thread_deleted_at is null then null else 'thread' end
      from todo t
      returning id, organization_id, user_id, size_bytes, deleted_at
    ),
    counted as (
      insert into storage_usage as u (organization_id, user_id, live_bytes, live_file_count,
        pending_bytes, pending_file_count)
      select organization_id, user_id,
        coalesce(sum(size_bytes) filter (where deleted_at is null), 0),
        count(*) filter (where deleted_at is null),
        coalesce(sum(size_bytes) filter (where deleted_at is not null), 0),
        count(*) filter (where deleted_at is not null)
      from made
      group by organization_id, user_id
      on conflict (user_id) do update set
        live_bytes = u.live_bytes + excluded.live_bytes,
        live_file_count = u.live_file_count + excluded.live_file_count,
        pending_bytes = u.pending_bytes + excluded.pending_bytes,
        pending_file_count = u.pending_file_count + excluded.pending_file_count,
        updated_at = now()
      returning 1
    ),
    rewritten as (
      update message m set parts = (
        select jsonb_agg(
          case when t.new_id is not null then
            jsonb_set(
              jsonb_set(p.part, '{data,id}', to_jsonb(t.new_id)),
              '{data,url}', to_jsonb(${contentUrl(sql`t.new_id`)}))
          else p.part end
          order by p.ord)
        from jsonb_array_elements(m.parts) with ordinality as p(part, ord)
        left join todo t on t.message_id = m.id and p.part ->> 'type' = 'data-attachment'
          and t.source_id = p.part #>> '{data,id}'
      )
      where m.id in (select message_id from todo)
      returning m.id
    )
    select (select count(*) from made)::int as copies,
           (select count(*) from rewritten)::int as messages
  `;
}

/**
 * The messages that descend from `ownerMessageIds` (a query of one `id`
 * column) through copy lineage: a fork's or an edit's message names the
 * message it was made from in `parent_message_id`, so a file that two
 * conversations share is carried by descendants of the message it was sent
 * with. Used by the purge paths, which cannot read every message of a person
 * to find a file's other users.
 */
export function descendantsOf(ownerMessageIds: SQL): SQL {
  return sql`
    with recursive lineage(id) as (
      select m.id from message m where m.parent_message_id in (${ownerMessageIds})
      union
      select m.id from message m join lineage l on m.parent_message_id = l.id
    )
    select id from lineage
  `;
}

const dialect = new PgDialect();

/** Runs `ownRowsStatement` on a postgres.js transaction (the background migration's). */
export async function runOwnRows(
  tx: postgres.TransactionSql,
  candidateIds: SQL,
): Promise<{ copies: number; messages: number }> {
  const query = dialect.sqlToQuery(ownRowsStatement(candidateIds));
  const rows = await tx.unsafe<{ copies: number; messages: number }[]>(
    query.sql,
    query.params as postgres.ParameterOrJSON<never>[],
  );
  return { copies: rows[0]?.copies ?? 0, messages: rows[0]?.messages ?? 0 };
}
