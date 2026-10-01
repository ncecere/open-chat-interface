import { eq, schema } from '@oci/db';
import { createUserSchema, type UserRole, updateUserSchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { clientIp } from '../../lib/client-ip.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseQuery } from '../../middleware/validate.js';
import { applyBulkUserAction, bulkActionSchema } from '../../services/admin-users/bulk-actions.js';
import { getUserDetail } from '../../services/admin-users/detail.js';
import { listQuerySchema, listUsers } from '../../services/admin-users/listing.js';
import {
  createUser,
  deleteUser,
  revokeUserSessions,
  updateUser,
} from '../../services/admin-users/mutations.js';
import { getUsageSummary } from '../../services/quota/index.js';
import { getStorageUsage } from '../../services/storage/quota.js';

export const userRoutes = new Hono<AppBindings>();

userRoutes.get('/', async (c) => {
  const query = parseQuery(c, listQuerySchema);
  return c.json(await listUsers(query));
});

userRoutes.post('/', async (c) => {
  const { id, email } = currentUser(c);
  const input = await parseBody(c, createUserSchema);
  return c.json(await createUser({ id, email }, input), 201);
});

userRoutes.post('/bulk', async (c) => {
  const { id, email } = currentUser(c);
  const input = await parseBody(c, bulkActionSchema);
  return c.json(await applyBulkUserAction({ id, email }, input, clientIp(c)));
});

userRoutes.get('/:id', async (c) => {
  return c.json(await getUserDetail(c.req.param('id')));
});

/**
 * The limits one person is held to right now: each budget with its current
 * usage and reset time, and storage use against the role's allowance. Computed
 * by the same functions enforcement uses.
 */
userRoutes.get('/:id/limits', async (c) => {
  const [target] = await db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, c.req.param('id')))
    .limit(1);
  if (!target) throw notFound('User not found');
  // The column is plain text; role values are validated on every write.
  const role = target.role as UserRole;
  const [usage, storage] = await Promise.all([
    getUsageSummary(target.id, role),
    getStorageUsage(target.id, role),
  ]);
  return c.json({ usage, storage });
});

userRoutes.patch('/:id', async (c) => {
  const { id, email } = currentUser(c);
  const targetId = c.req.param('id');
  const patch = await parseBody(c, updateUserSchema);
  return c.json(await updateUser({ id, email }, targetId, patch));
});

userRoutes.post('/:id/revoke-sessions', async (c) => {
  const { id, email } = currentUser(c);
  return c.json(await revokeUserSessions({ id, email }, c.req.param('id')));
});

userRoutes.delete('/:id', async (c) => {
  const { id, email } = currentUser(c);
  return c.json(await deleteUser({ id, email }, c.req.param('id')));
});
