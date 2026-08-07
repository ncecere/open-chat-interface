import { count, desc, eq, ilike, or, schema, sql } from '@oci/db';
import { type AdminUser, createUserSchema, updateUserSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseQuery } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';

export const userRoutes = new Hono<AppBindings>();

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
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
  const { search, limit, offset } = parseQuery(c, listQuerySchema);

  const where = search
    ? or(ilike(schema.user.email, `%${search}%`), ilike(schema.user.name, `%${search}%`))
    : undefined;

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
      threadCount: sql<number>`(select count(*) from ${schema.thread} where ${schema.thread.userId} = ${schema.user.id})::int`,
      messageCount: sql<number>`(select count(*) from ${schema.message} where ${schema.message.userId} = ${schema.user.id})::int`,
    })
    .from(schema.user)
    .where(where)
    .orderBy(desc(schema.user.createdAt))
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
