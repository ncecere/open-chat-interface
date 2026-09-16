import { and, asc, count, desc, eq, ilike, or, schema, sql } from '@oci/db';
import { type AdminUser, USER_ROLES } from '@oci/shared';
import { z } from 'zod';
import { db } from '../../db/index.js';

/** Sorting and filtering describe the whole user base, not just the loaded page. */
export const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['active', 'banned', 'unverified']).optional(),
  sort: z
    .enum(['created', 'name', 'email', 'role', 'lastSeen', 'threads', 'messages'])
    .default('created'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function toAdminUser(row: {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: string;
  emailVerified: boolean;
  banned: boolean;
  banReason: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  threadCount: number;
  messageCount: number;
}): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    role: row.role as AdminUser['role'],
    emailVerified: row.emailVerified,
    banned: row.banned,
    banReason: row.banReason,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    threadCount: row.threadCount,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listUsers({
  search,
  role,
  status,
  sort,
  direction,
  limit,
  offset,
}: z.infer<typeof listQuerySchema>) {
  const filters = [
    search
      ? or(ilike(schema.user.email, `%${search}%`), ilike(schema.user.name, `%${search}%`))
      : undefined,
    role ? eq(schema.user.role, role) : undefined,
    status === 'banned' ? eq(schema.user.banned, true) : undefined,
    // "Active" means not banned, rather than recently seen: a ban is the thing
    // an administrator is usually filtering for.
    status === 'active' ? eq(schema.user.banned, false) : undefined,
    status === 'unverified' ? eq(schema.user.emailVerified, false) : undefined,
  ].filter((clause) => clause !== undefined);

  const where = filters.length > 0 ? and(...filters) : undefined;
  const threadCountSql = sql<number>`(select count(*) from ${schema.thread} where ${schema.thread.userId} = ${schema.user.id})::int`;
  const messageCountSql = sql<number>`(select count(*) from ${schema.message} where ${schema.message.userId} = ${schema.user.id})::int`;
  const sortColumn = {
    created: schema.user.createdAt,
    name: schema.user.name,
    email: schema.user.email,
    role: schema.user.role,
    lastSeen: schema.user.lastSeenAt,
    threads: threadCountSql,
    messages: messageCountSql,
  }[sort];
  const order = direction === 'asc' ? asc(sortColumn) : desc(sortColumn);

  const rows = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
      image: schema.user.image,
      role: schema.user.role,
      emailVerified: schema.user.emailVerified,
      banned: schema.user.banned,
      banReason: schema.user.banReason,
      lastSeenAt: schema.user.lastSeenAt,
      createdAt: schema.user.createdAt,
      threadCount: threadCountSql,
      messageCount: messageCountSql,
    })
    .from(schema.user)
    .where(where)
    // A stable tiebreak keeps pagination from repeating or dropping a row when
    // the sort column has duplicates.
    .orderBy(order, desc(schema.user.id))
    .limit(limit)
    .offset(offset);

  const [totals] = await db.select({ value: count() }).from(schema.user).where(where);
  return { users: rows.map(toAdminUser), total: totals?.value ?? 0 };
}
