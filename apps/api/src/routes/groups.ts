import {
  listGroupMembersQuerySchema,
  managerAddGroupMembersSchema,
  PERSON_LOOKUPS_PER_MINUTE,
} from '@oci/shared';
import { Hono } from 'hono';
import { rateLimited } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  addGroupMembers,
  listGroupMembers,
  listManagedGroups,
  listMyGroups,
  removeGroupMember,
  requireGroupManager,
} from '../services/groups/membership.js';
import { consumeRateLimit } from '../services/limits/rate-limit.js';

/**
 * Groups for any signed-in person (v0.14, #394): the groups they are in (the
 * share dialog's choices) and, for a manager, the member list of their own
 * groups, adding members by email and removing them. A manager sees and does
 * nothing else: no grants, no usage, no roles (administrators use
 * `/api/admin/groups`). Which refusal a person gets is decided by
 * `requireGroupManager`. Endpoints and shapes: docs/dev/groups-api.md.
 */
export const groupRoutes = new Hono<AppBindings>();

groupRoutes.use('*', requireAuth);

groupRoutes.get('/mine', async (c) => {
  return c.json({ groups: await listMyGroups(currentUser(c).id) });
});

groupRoutes.get('/managed', async (c) => {
  return c.json({ groups: await listManagedGroups(currentUser(c).id) });
});

groupRoutes.get('/managed/:id/members', async (c) => {
  const user = currentUser(c);
  const id = c.req.param('id');
  await requireGroupManager(user.id, id);
  return c.json(await listGroupMembers(id, parseQuery(c, listGroupMembersQuerySchema)));
});

groupRoutes.post('/managed/:id/members', async (c) => {
  const user = currentUser(c);
  const id = c.req.param('id');
  await requireGroupManager(user.id, id);
  const input = await parseBody(c, managerAddGroupMembersSchema);

  // Looking people up by address tells a manager who has an account: bounded.
  const limit = await consumeRateLimit({
    bucket: 'person-lookup',
    identifier: user.id,
    limit: PERSON_LOOKUPS_PER_MINUTE,
  });
  if (!limit.allowed) {
    throw rateLimited('Too many lookups. Wait a moment and try again.', limit.retryAfterSeconds);
  }

  return c.json(
    await addGroupMembers({
      actor: user,
      groupId: id,
      emails: input.emails,
      role: 'member',
      asManager: true,
    }),
  );
});

groupRoutes.delete('/managed/:id/members/:userId', async (c) => {
  const user = currentUser(c);
  const id = c.req.param('id');
  await requireGroupManager(user.id, id);
  await removeGroupMember({
    actor: user,
    groupId: id,
    userId: c.req.param('userId'),
    asManager: true,
  });
  return c.json({ ok: true });
});
