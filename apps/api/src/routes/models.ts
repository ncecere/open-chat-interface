import { Hono } from 'hono';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { listAvailableModels } from '../services/models.js';

export const modelCatalogRoutes = new Hono<AppBindings>();

modelCatalogRoutes.use('*', requireAuth);

modelCatalogRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const models = await listAvailableModels(user.role);
  return c.json({ models });
});
