import { and, asc, count, desc, eq, schema, sql } from '@oci/db';
import type { ChatHistoryPage } from '@oci/shared';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { activeMessage, latestTurnReplies } from './reply-path.js';

/**
 * A conversation a page at a time (v0.11, long conversations in the browser).
 *
 * Pages are windows of the conversation as it reads: the active path, one
 * reply per turn, in the order `listConversation` returns it (position, then
 * creation time, then id). Branches are separate conversations, so nothing
 * from another branch can appear. A cursor is the id of the message at the
 * edge of a page; the next page is everything strictly before (or after) that
 * row in the same order, compared in SQL against the stored row so creation
 * times keep their full precision. New messages only ever come after the
 * existing ones, so a cursor taken before they arrived still continues
 * exactly where its page stopped.
 */
export type HistoryPageRequest =
  | { kind: 'latest'; limit: number }
  | { kind: 'before'; cursor: string; limit: number }
  | { kind: 'after'; cursor: string; limit: number }
  | { kind: 'around'; messageId: string; limit: number };

type Row = typeof schema.message.$inferSelect;
type SQL = ReturnType<typeof sql.raw>;

export const INVALID_HISTORY_CURSOR = 'That page cursor is not valid';

const m = schema.message;
/** The listing order as one row value, for keyset comparisons. */
const order = sql`(${m.position}, ${m.createdAt}, ${m.id})`;
const anchorRow = (threadId: string, id: string) =>
  sql`(select a.position, a.created_at, a.id from ${m} a where a.id = ${id} and a.thread_id = ${threadId})`;

async function messageInThread(threadId: string, id: string) {
  const [row] = await db
    .select({ id: m.id, supersededAt: m.supersededAt })
    .from(m)
    .where(and(eq(m.threadId, threadId), eq(m.id, id)))
    .limit(1);
  return row ?? null;
}

/** Up to `limit` active rows on one side of `edge` (or the end), oldest first, and whether more lie beyond. */
async function side(
  threadId: string,
  direction: 'older' | 'newer',
  limit: number,
  edge: SQL | null,
): Promise<{ rows: Row[]; more: boolean }> {
  if (limit <= 0) {
    // Only whether anything lies that way.
    const [row] = await db
      .select({ id: m.id })
      .from(m)
      .where(and(eq(m.threadId, threadId), activeMessage(), edge ?? undefined))
      .limit(1);
    return { rows: [], more: Boolean(row) };
  }
  const older = direction === 'older';
  const rows = await db
    .select()
    .from(m)
    .where(and(eq(m.threadId, threadId), activeMessage(), edge ?? undefined))
    .orderBy(
      ...(older
        ? [desc(m.position), desc(m.createdAt), desc(m.id)]
        : [asc(m.position), asc(m.createdAt), asc(m.id)]),
    )
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { rows: older ? page.reverse() : page, more };
}

/** Every reply to the latest user turn when it was retried; otherwise empty. */
async function latestReplies(threadId: string): Promise<Row[]> {
  const [prompt] = await db
    .select({ position: sql<number | null>`max(${m.position})::int` })
    .from(m)
    .where(and(eq(m.threadId, threadId), eq(m.role, 'user')));
  if (prompt?.position === null || prompt?.position === undefined) return [];
  const rows = await db
    .select()
    .from(m)
    .where(and(eq(m.threadId, threadId), sql`${m.position} >= ${prompt.position}`))
    .orderBy(asc(m.position), asc(m.createdAt), asc(m.id));
  return latestTurnReplies(rows);
}

async function activeTotal(threadId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(m)
    .where(and(eq(m.threadId, threadId), activeMessage()));
  return row?.value ?? 0;
}

/**
 * One page of a conversation, with `replies` (every reply to the latest turn,
 * when it was retried) whenever the page reaches the latest message: the
 * reply switcher only ever switches the latest turn.
 *
 * - `latest`: the newest `limit` messages.
 * - `before` / `after`: the `limit` messages before or after a cursor. A
 *   cursor that names no message of this conversation is refused (422).
 * - `around`: a window with the message in it (about half before, half from
 *   it on), for opening a conversation at a search result. A message not on
 *   the conversation's active path (a replaced reply, another conversation's,
 *   a deleted one) gives the latest page with `targetFound: false`, so the
 *   reader opens at the end as before.
 */
export async function readConversationPage(threadId: string, request: HistoryPageRequest) {
  let rows: Row[];
  let olderMore: boolean;
  let newerMore: boolean;
  let targetFound: boolean | undefined;

  if (request.kind === 'before' || request.kind === 'after') {
    if (!(await messageInThread(threadId, request.cursor)))
      throw validationFailed(INVALID_HISTORY_CURSOR);
    const anchor = anchorRow(threadId, request.cursor);
    if (request.kind === 'before') {
      const page = await side(threadId, 'older', request.limit, sql`${order} < ${anchor}`);
      rows = page.rows;
      olderMore = page.more;
      // The cursor's own message follows the page (when there is a page).
      newerMore = rows.length > 0;
    } else {
      const page = await side(threadId, 'newer', request.limit, sql`${order} > ${anchor}`);
      rows = page.rows;
      newerMore = page.more;
      olderMore = rows.length > 0;
    }
  } else if (request.kind === 'around') {
    const target = await messageInThread(threadId, request.messageId);
    if (target && target.supersededAt === null) {
      targetFound = true;
      const anchor = anchorRow(threadId, request.messageId);
      const beforeCount = Math.floor((request.limit - 1) / 2);
      const olderEdge = sql`${order} < ${anchor}`;
      // About half before; near either end, the rest of the page from the other side.
      let older = await side(threadId, 'older', beforeCount, olderEdge);
      const newer = await side(
        threadId,
        'newer',
        request.limit - older.rows.length,
        sql`${order} >= ${anchor}`,
      );
      if (!newer.more && older.more && older.rows.length + newer.rows.length < request.limit)
        older = await side(threadId, 'older', request.limit - newer.rows.length, olderEdge);
      rows = [...older.rows, ...newer.rows];
      olderMore = older.more;
      newerMore = newer.more;
    } else {
      targetFound = false;
      const page = await side(threadId, 'older', request.limit, null);
      rows = page.rows;
      olderMore = page.more;
      newerMore = false;
    }
  } else {
    const page = await side(threadId, 'older', request.limit, null);
    rows = page.rows;
    olderMore = page.more;
    newerMore = false;
  }

  const [total, replies] = await Promise.all([
    activeTotal(threadId),
    // Only a page that reaches the latest message carries the switcher's replies.
    newerMore || (request.kind === 'before' && rows.length === 0)
      ? Promise.resolve([] as Row[])
      : latestReplies(threadId),
  ]);
  const page: ChatHistoryPage = {
    olderCursor: olderMore && rows[0] ? rows[0].id : null,
    newerCursor: newerMore && rows.at(-1) ? rows.at(-1)!.id : null,
    total,
    ...(targetFound === undefined ? {} : { targetFound }),
  };
  return { messages: rows, replies, page };
}
