import {
  USER_ROLES,
  type UserRole,
  updateRoleFeaturesSchema,
  updateRoleToolsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { roleFeatures, updateRoleFeatures } from '../../services/role-features.js';
import { getRolesAccess } from '../../services/roles-access.js';
import { diffSettings } from '../../services/settings-diff.js';
import { roleTools, updateRoleTools } from '../../services/tools/role-tools.js';

export const rolesRoutes = new Hono<AppBindings>();

/** One summary per role; most parts change through their own endpoints. */
rolesRoutes.get('/', async (c) => c.json(await getRolesAccess()));

/**
 * Changes a role's feature switches and allowed reasoning levels. Only sent
 * fields change. Auditors are refused by the admin method guard.
 */
rolesRoutes.put('/:role', async (c) => {
  const actor = currentUser(c);
  const role = c.req.param('role');
  if (!USER_ROLES.includes(role as UserRole)) throw notFound('Role not found');

  const patch = await parseBody(c, updateRoleFeaturesSchema);
  const previous = await roleFeatures(role as UserRole);
  const next = await updateRoleFeatures(role as UserRole, patch);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'role.features.update',
    targetType: 'role',
    targetId: role,
    // Compared against the stored result so a normalized list (instant added,
    // levels reordered) is recorded as it now stands.
    metadata: {
      keys: Object.keys(patch),
      changes: diffSettings(
        previous,
        Object.fromEntries(Object.keys(patch).map((key) => [key, next[key as keyof typeof next]])),
      ),
    },
  });

  return c.json({ role, roleFeatures: next });
});

/**
 * Allows or withholds tools for one role. Only sent tools change; a tool never
 * saved keeps its default. Auditors are refused by the admin method guard.
 */
rolesRoutes.put('/:role/tools', async (c) => {
  const actor = currentUser(c);
  const role = c.req.param('role');
  if (!USER_ROLES.includes(role as UserRole)) throw notFound('Role not found');

  const patch = await parseBody(c, updateRoleToolsSchema);
  const previous = await roleTools(role as UserRole);
  const next = await updateRoleTools(role as UserRole, patch);
  const allowed = (tools: typeof next) =>
    Object.fromEntries(
      tools.filter((tool) => tool.id in patch.tools).map((tool) => [tool.id, tool.allowed]),
    );

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'role.tools.update',
    targetType: 'role',
    targetId: role,
    metadata: {
      tools: Object.keys(patch.tools),
      changes: diffSettings(allowed(previous), allowed(next)),
    },
  });

  return c.json({ role, tools: next });
});
