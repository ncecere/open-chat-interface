import { and, desc, eq, isNull, or, schema, sql } from '@oci/db';
import type { ActiveBroadcast, Broadcast, UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { getDefaultOrganizationId } from './organization.js';

/**
 * Announcements a person should currently see.
 *
 * Windowing, audience, and dismissal are all applied in the query rather than
 * filtered afterwards, so an announcement someone has hidden or that is not
 * yet live never reaches the client at all.
 */
export async function activeBroadcastsFor(
  userId: string,
  role: UserRole,
): Promise<ActiveBroadcast[]> {
  const organizationId = await getDefaultOrganizationId();
  // Raw SQL binds text, so the boundary is passed as an ISO string.
  const now = new Date().toISOString();

  const rows = await db
    .select({
      id: schema.broadcast.id,
      title: schema.broadcast.title,
      body: schema.broadcast.body,
      level: schema.broadcast.level,
      dismissable: schema.broadcast.dismissable,
    })
    .from(schema.broadcast)
    .leftJoin(
      schema.broadcastDismissal,
      and(
        eq(schema.broadcastDismissal.broadcastId, schema.broadcast.id),
        eq(schema.broadcastDismissal.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.broadcast.organizationId, organizationId),
        eq(schema.broadcast.published, true),
        or(
          isNull(schema.broadcast.startsAt),
          sql`${schema.broadcast.startsAt} <= ${now}::timestamptz`,
        ),
        or(isNull(schema.broadcast.endsAt), sql`${schema.broadcast.endsAt} > ${now}::timestamptz`),
        // An empty audience means everyone.
        sql`(jsonb_array_length(${schema.broadcast.audienceRoles}) = 0
             or ${schema.broadcast.audienceRoles} @> ${JSON.stringify([role])}::jsonb)`,
        isNull(schema.broadcastDismissal.id),
      ),
    )
    .orderBy(desc(schema.broadcast.createdAt))
    .limit(5);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    dismissable: row.dismissable,
  }));
}

/**
 * Records that a person has hidden an announcement.
 *
 * Idempotent, because a client retrying a dismissal should not fail. A
 * non-dismissable announcement is refused here rather than only in the UI,
 * since the interface is not an enforcement boundary.
 */
export async function dismissBroadcast(broadcastId: string, userId: string): Promise<boolean> {
  const [target] = await db
    .select({ dismissable: schema.broadcast.dismissable })
    .from(schema.broadcast)
    .where(eq(schema.broadcast.id, broadcastId))
    .limit(1);

  if (!target?.dismissable) return false;

  await db.insert(schema.broadcastDismissal).values({ broadcastId, userId }).onConflictDoNothing();

  return true;
}

/** Whether an announcement is on screen for its audience right now. */
function isActive(row: {
  published: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}): boolean {
  if (!row.published) return false;
  const now = Date.now();
  if (row.startsAt && row.startsAt.getTime() > now) return false;
  if (row.endsAt && row.endsAt.getTime() <= now) return false;
  return true;
}

export async function listBroadcasts(): Promise<Broadcast[]> {
  const organizationId = await getDefaultOrganizationId();

  const rows = await db
    .select({
      id: schema.broadcast.id,
      title: schema.broadcast.title,
      body: schema.broadcast.body,
      level: schema.broadcast.level,
      audienceRoles: schema.broadcast.audienceRoles,
      dismissable: schema.broadcast.dismissable,
      published: schema.broadcast.published,
      startsAt: schema.broadcast.startsAt,
      endsAt: schema.broadcast.endsAt,
      createdAt: schema.broadcast.createdAt,
      dismissalCount: sql<number>`(select count(*) from ${schema.broadcastDismissal}
        where ${schema.broadcastDismissal.broadcastId} = ${schema.broadcast.id})::int`,
    })
    .from(schema.broadcast)
    .where(eq(schema.broadcast.organizationId, organizationId))
    .orderBy(desc(schema.broadcast.createdAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    audienceRoles: row.audienceRoles,
    dismissable: row.dismissable,
    published: row.published,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    active: isActive(row),
    dismissalCount: Number(row.dismissalCount),
    createdAt: row.createdAt.toISOString(),
  }));
}
