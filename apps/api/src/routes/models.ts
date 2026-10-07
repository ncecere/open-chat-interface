import { Hono } from 'hono';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { hasUsableModels, listAvailableModels } from '../services/models.js';

export const modelCatalogRoutes = new Hono<AppBindings>();

modelCatalogRoutes.use('*', requireAuth);

/** The models the person's role may use, and whether an empty list is the role's doing. */
modelCatalogRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const models = await listAvailableModels(user.role);
  // With none for this role, whether that is the role or the instance: the
  // two need different words, and the person different help (#303).
  const hiddenFromRole = models.length === 0 && (await hasUsableModels());
  return c.json({ models, hiddenFromRole });
});
