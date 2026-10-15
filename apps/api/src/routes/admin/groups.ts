import {
  addGroupMembersSchema,
  createGroupSchema,
  listGroupMembersQuerySchema,
  listGroupsQuerySchema,
  putGroupGrantsSchema,
  updateGroupMemberSchema,
  updateGroupSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseChanges, parseQuery } from '../../middleware/validate.js';
import { putGroupGrants } from '../../services/groups/grants.js';
import {
  createGroup,
  deleteGroup,
  getGroupDetail,
  getGroupGrants,
  listGroups,
  updateGroup,
} from '../../services/groups/groups.js';
import {
  addGroupMembers,
  changeMemberRole,
  listGroupMembers,
  listUserGroups,
  removeGroupMember,
} from '../../services/groups/membership.js';

/**
 * Administering groups (v0.14, #394). Mounted under `/api/admin`, so
 * `requireAdmin` applies: an auditor reads, only an administrator changes.
 * Endpoints and shapes: docs/dev/groups-api.md.
 */
export const groupAdminRoutes = new Hono<AppBindings>();

groupAdminRoutes.get('/', async (c) => {
  return c.json(await listGroups(parseQuery(c, listGroupsQuerySchema)));
});

groupAdminRoutes.post('/', async (c) => {
  const input = await parseBody(c, createGroupSchema);
  return c.json(await createGroup(currentUser(c), input), 201);
});

groupAdminRoutes.get('/:id', async (c) => {
  return c.json(await getGroupDetail(c.req.param('id')));
});

groupAdminRoutes.patch('/:id', async (c) => {
  const input = await parseChanges(c, updateGroupSchema);
  return c.json(await updateGroup(currentUser(c), c.req.param('id'), input));
});

groupAdminRoutes.delete('/:id', async (c) => {
  return c.json(await deleteGroup(currentUser(c), c.req.param('id')));
});

groupAdminRoutes.get('/:id/members', async (c) => {
  const query = parseQuery(c, listGroupMembersQuerySchema);
  return c.json(await listGroupMembers(c.req.param('id'), query));
});

groupAdminRoutes.post('/:id/members', async (c) => {
  const input = await parseBody(c, addGroupMembersSchema);
  return c.json(
    await addGroupMembers({
      actor: currentUser(c),
      groupId: c.req.param('id'),
      emails: input.emails,
      role: input.role,
    }),
  );
});

groupAdminRoutes.patch('/:id/members/:userId', async (c) => {
  const input = await parseBody(c, updateGroupMemberSchema);
  return c.json(
    await changeMemberRole({
      actor: currentUser(c),
      groupId: c.req.param('id'),
      userId: c.req.param('userId'),
      role: input.role,
    }),
  );
});

groupAdminRoutes.delete('/:id/members/:userId', async (c) => {
  await removeGroupMember({
    actor: currentUser(c),
    groupId: c.req.param('id'),
    userId: c.req.param('userId'),
  });
  return c.json({ ok: true });
});

groupAdminRoutes.get('/:id/grants', async (c) => {
  return c.json(await getGroupGrants(c.req.param('id')));
});

/**
 * Replaces what the group grants. The one place grants are written: the budget
 * and model forms never carry groups.
 */
groupAdminRoutes.put('/:id/grants', async (c) => {
  const input = await parseBody(c, putGroupGrantsSchema);
  return c.json(await putGroupGrants(currentUser(c), c.req.param('id'), input));
});

/**
 * Mounted at `/api/admin/users` before the user routes, as the override routes
 * are, so the person's groups are one more path under the user.
 */
export const userGroupRoutes = new Hono<AppBindings>();

userGroupRoutes.get('/:id/groups', async (c) => {
  return c.json({ groups: await listUserGroups(c.req.param('id')) });
});
