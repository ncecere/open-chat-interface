import { and, desc, eq, ilike, isNull, schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { containsPattern } from '../lib/like.js';

/**
 * Settings → History's pages of conversations (split from threads.ts).
 */

/** Where a history page ends: the last row's activity time (to the millisecond) and id. */
export interface ThreadHistoryCursor {
  activityAt: Date;
  id: string;
}

/** A conversation's latest activity: its last message, or its creation if it has none. */
export function threadActivityAt(thread: { lastMessageAt: Date | null; createdAt: Date }): Date {
  return thread.lastMessageAt ?? thread.createdAt;
}

export function encodeThreadHistoryCursor(thread: {
  lastMessageAt: Date | null;
  createdAt: Date;
  id: string;
}): string {
  return `${threadActivityAt(thread).toISOString()}|${thread.id}`;
}

/** Null for anything that is not a cursor this API issued. */
export function decodeThreadHistoryCursor(value: string): ThreadHistoryCursor | null {
  const separator = value.indexOf('|');
  if (separator < 0) return null;
  const activityAt = new Date(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (Number.isNaN(activityAt.getTime()) || !id || id.length > 200) return null;
  return { activityAt, id };
}

/**
 * Settings → History (v0.9.1): every live conversation, a page at a time.
 *
 * Ordered by latest activity (the last message, else creation: the time each
 * row shows) then id, newest first, without the sidebar's pinned grouping, so
 * a cursor (the last row's activity time and id) always continues exactly
 * where the previous page stopped. Times are compared to the millisecond
 * because that is what the cursor can carry. Not by the last update: renaming,
 * pinning or moving a conversation into a project updates it, which put it
 * above conversations its shown time said were newer (#151).
 */
export async function listThreadHistory(
  userId: string,
  options: { search?: string; archived?: boolean; before?: ThreadHistoryCursor; limit: number },
) {
  const activityMs = sql`date_trunc('milliseconds', coalesce(${schema.thread.lastMessageAt}, ${schema.thread.createdAt}))`;
  const conditions = [
    eq(schema.thread.userId, userId),
    eq(schema.thread.archived, options.archived ?? false),
    eq(schema.thread.temporary, false),
    isNull(schema.thread.deletedAt),
  ];
  if (options.search) conditions.push(ilike(schema.thread.title, containsPattern(options.search)));
  if (options.before) {
    conditions.push(
      sql`(${activityMs}, ${schema.thread.id}) < (${options.before.activityAt.toISOString()}::timestamptz, ${options.before.id})`,
    );
  }
  const rows = await db
    .select()
    .from(schema.thread)
    .where(and(...conditions))
    .orderBy(sql`${activityMs} desc`, desc(schema.thread.id))
    .limit(options.limit + 1);
  const threads = rows.slice(0, options.limit);
  const last = threads.at(-1);
  return {
    threads,
    nextCursor: rows.length > options.limit && last ? encodeThreadHistoryCursor(last) : null,
  };
}
