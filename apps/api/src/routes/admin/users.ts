import { and, asc, count, desc, eq, ilike, inArray, isNull, or, schema, sql } from '@oci/db';
import { type AdminUser, createUserSchema, USER_ROLES, updateUserSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { isEmailVerificationEnforced } from '../../auth/policy.js';
import { db } from '../../db/index.js';
import { clientIp } from '../../lib/client-ip.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseQuery } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';

export const userRoutes = new Hono<AppBindings>();

/**
 * Sorting and filtering happen in the query rather than on the loaded page, so
 * they describe the whole user base instead of whichever fifty rows arrived.
 */
const listQuerySchema = z.object({
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

function toAdminUser(row: {
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

userRoutes.get('/', async (c) => {
  const { search, role, status, sort, direction, limit, offset } = parseQuery(c, listQuerySchema);

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

  return c.json({ users: rows.map(toAdminUser), total: totals?.value ?? 0 });
});

userRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createUserSchema);

  const [existing] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, input.email))
    .limit(1);

  if (existing) throw conflict('A user with that email already exists');

  const created = await auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: input.role === 'admin' ? 'admin' : 'user',
    },
  });

  if (input.role === 'restricted') {
    await db
      .update(schema.user)
      .set({ role: 'restricted' })
      .where(eq(schema.user.id, created.user.id));
  }

  if (await isEmailVerificationEnforced()) {
    try {
      await auth.api.sendVerificationEmail({
        body: { email: input.email, callbackURL: '/' },
      });
    } catch {
      // Email delivery must never create an unusable administrator-created account.
      await db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, created.user.id));
    }
  } else {
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, created.user.id));
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.create',
    targetType: 'user',
    targetId: created.user.id,
    metadata: { email: input.email, role: input.role },
  });

  return c.json({ id: created.user.id }, 201);
});

/**
 * Everything an administrator needs about one account in a single response.
 *
 * Gathered here rather than left to the client because the alternative is five
 * round trips to render one screen, and the questions being asked — why is this
 * person hitting a limit, what have they been doing, is this account
 * compromised — are all asked at once.
 */
/**
 * Applies one change to several accounts.
 *
 * At twenty thousand users, changing a role or revoking sessions one account
 * at a time is not a workflow. Bounded at two hundred per request so a single
 * call cannot rewrite the whole directory by accident.
 */
const bulkActionSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['set_role', 'ban', 'unban', 'revoke_sessions']),
  role: z.enum(USER_ROLES).optional(),
  reason: z.string().trim().max(500).optional(),
});

userRoutes.post('/bulk', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, bulkActionSchema);

  if (input.action === 'set_role' && !input.role) {
    throw validationFailed('Choose a role to apply.', [
      { path: ['role'], message: 'Required when setting a role' },
    ]);
  }

  // An administrator removing their own access, or locking themselves out
  // mid-operation, is a mistake the API should not help with.
  const targets = input.userIds.filter((id) => id !== actor.id);
  const skippedSelf = targets.length !== input.userIds.length;

  if (targets.length === 0) {
    throw validationFailed('Select an account other than your own.', [
      { path: ['userIds'], message: 'Your own account cannot be changed in bulk' },
    ]);
  }

  let affected = 0;

  if (input.action === 'set_role' && input.role) {
    const rows = await db
      .update(schema.user)
      .set({ role: input.role })
      .where(inArray(schema.user.id, targets))
      .returning({ id: schema.user.id });
    affected = rows.length;
  } else if (input.action === 'ban' || input.action === 'unban') {
    const banned = input.action === 'ban';
    const rows = await db
      .update(schema.user)
      .set({ banned, banReason: banned ? (input.reason ?? null) : null })
      .where(inArray(schema.user.id, targets))
      .returning({ id: schema.user.id });
    affected = rows.length;

    // A ban that leaves the session alive is not a ban until it expires.
    if (banned) {
      await db.delete(schema.session).where(inArray(schema.session.userId, targets));
    }
  } else {
    const rows = await db
      .delete(schema.session)
      .where(inArray(schema.session.userId, targets))
      .returning({ id: schema.session.id });
    affected = rows.length;
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: `user.bulk.${input.action}`,
    targetType: 'user',
    targetId: null,
    ipAddress: clientIp(c),
    metadata: {
      requested: input.userIds.length,
      affected,
      ...(input.role ? { role: input.role } : {}),
      // Recorded rather than summarised: an audit entry saying "47 accounts"
      // without naming them cannot be checked afterwards.
      userIds: targets,
    },
  });

  return c.json({ affected, skippedSelf });
});

userRoutes.get('/:id', async (c) => {
  const targetId = c.req.param('id');

  const [target] = await db.select().from(schema.user).where(eq(schema.user.id, targetId)).limit(1);

  if (!target) throw notFound('User not found');

  const [threads, messages, storage, sessions, recentThreads, auditEntries] = await Promise.all([
    db.select({ value: count() }).from(schema.thread).where(eq(schema.thread.userId, targetId)),
    db.select({ value: count() }).from(schema.message).where(eq(schema.message.userId, targetId)),
    db
      .select({ bytes: schema.storageUsage.liveBytes, files: schema.storageUsage.liveFileCount })
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, targetId))
      .limit(1),
    db
      .select({
        id: schema.session.id,
        createdAt: schema.session.createdAt,
        expiresAt: schema.session.expiresAt,
        ipAddress: schema.session.ipAddress,
        userAgent: schema.session.userAgent,
      })
      .from(schema.session)
      .where(eq(schema.session.userId, targetId))
      .orderBy(desc(schema.session.createdAt))
      .limit(10),
    db
      .select({
        id: schema.thread.id,
        title: schema.thread.title,
        updatedAt: schema.thread.updatedAt,
      })
      .from(schema.thread)
      .where(and(eq(schema.thread.userId, targetId), isNull(schema.thread.deletedAt)))
      .orderBy(desc(schema.thread.updatedAt))
      .limit(10),
    // Matched on the account as actor and as target, so an action taken
    // against this person appears beside the ones they took themselves.
    db
      .select()
      .from(schema.auditLog)
      .where(or(eq(schema.auditLog.actorUserId, targetId), eq(schema.auditLog.targetId, targetId)))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(25),
  ]);

  return c.json({
    user: toAdminUser({
      ...target,
      threadCount: threads[0]?.value ?? 0,
      messageCount: messages[0]?.value ?? 0,
    }),
    storage: {
      bytesUsed: Number(storage[0]?.bytes ?? 0),
      fileCount: storage[0]?.files ?? 0,
    },
    sessions: sessions.map((session) => ({
      ...session,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
    recentThreads: recentThreads.map((thread) => ({
      ...thread,
      updatedAt: thread.updatedAt.toISOString(),
    })),
    audit: auditEntries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
});

userRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const targetId = c.req.param('id');
  const patch = await parseBody(c, updateUserSchema);

  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, targetId))
    .limit(1);

  if (!target) throw notFound('User not found');

  if (targetId === actor.id && patch.role && patch.role !== 'admin') {
    throw validationFailed('You cannot remove your own administrator role');
  }
  if (targetId === actor.id && patch.banned) {
    throw validationFailed('You cannot ban your own account');
  }

  const [updated] = await db
    .update(schema.user)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.role !== undefined && { role: patch.role }),
      ...(patch.banned !== undefined && { banned: patch.banned }),
      ...(patch.banReason !== undefined && { banReason: patch.banReason }),
    })
    .where(eq(schema.user.id, targetId))
    .returning({ id: schema.user.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.update',
    targetType: 'user',
    targetId,
    metadata: patch,
  });

  return c.json({ id: updated?.id });
});

userRoutes.post('/:id/revoke-sessions', async (c) => {
  const actor = currentUser(c);
  const targetId = c.req.param('id');

  await db.delete(schema.session).where(eq(schema.session.userId, targetId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.revoke_sessions',
    targetType: 'user',
    targetId,
  });

  return c.json({ ok: true });
});

userRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const targetId = c.req.param('id');

  if (targetId === actor.id) {
    throw validationFailed('You cannot delete your own account');
  }

  await db.delete(schema.user).where(eq(schema.user.id, targetId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.delete',
    targetType: 'user',
    targetId,
  });

  return c.json({ ok: true });
});
