import { Hono } from 'hono';
import type { AppBindings } from '../middleware/context.js';
import { readOnlyStatus } from '../services/maintenance/read-only.js';

/**
 * Whether this instance is read-only now (v0.11 design, section 9), for the
 * web app's banner and composer. Unauthenticated, like branding: the sign-in
 * page can say so too, and it holds nothing private (the reason is what
 * everyone is shown).
 */
export const maintenanceRoutes = new Hono<AppBindings>();

maintenanceRoutes.get('/', async (c) => {
  c.header('cache-control', 'no-store');
  return c.json(await readOnlyStatus());
});
