import { createUserSchema, updateUserSchema } from '@oci/shared';
import { Hono } from 'hono';
import { clientIp } from '../../lib/client-ip.js';
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
