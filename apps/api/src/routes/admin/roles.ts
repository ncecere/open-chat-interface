import { USER_ROLES, type UserRole, updateRoleFeaturesSchema } from '@oci/shared';
import { Hono } from 'hono';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { roleFeatures, updateRoleFeatures } from '../../services/role-features.js';
import { getRolesAccess } from '../../services/roles-access.js';
import { diffSettings } from '../../services/settings-diff.js';

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
