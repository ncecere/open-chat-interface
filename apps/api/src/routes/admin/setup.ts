import { Hono } from 'hono';
import type { AppBindings } from '../../middleware/context.js';
import { getSetupStatus } from '../../services/setup-status.js';

export const setupRoutes = new Hono<AppBindings>();

/** Configuration checklist for the admin overview; read-only, safe for auditors. */
setupRoutes.get('/', async (c) => c.json(await getSetupStatus()));
