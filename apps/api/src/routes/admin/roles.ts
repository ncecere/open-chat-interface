import { Hono } from 'hono';
import type { AppBindings } from '../../middleware/context.js';
import { getRolesAccess } from '../../services/roles-access.js';

export const rolesRoutes = new Hono<AppBindings>();

/** One summary per role; changes go through each part's own endpoint. */
rolesRoutes.get('/', async (c) => c.json(await getRolesAccess()));
