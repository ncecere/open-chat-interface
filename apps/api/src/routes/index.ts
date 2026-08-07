import { Hono } from 'hono';
import { auth } from '../auth/index.js';
import type { AppBindings } from '../middleware/context.js';
import { adminRoutes } from './admin/index.js';
import { authStatusRoutes } from './auth-status.js';
import { chatRoutes } from './chat.js';
import { healthRoutes } from './health.js';
import { meRoutes } from './me.js';
import { modelCatalogRoutes } from './models.js';
import { threadRoutes } from './threads.js';

export function createApiRoutes() {
  const api = new Hono<AppBindings>();

  api.route('/health', healthRoutes);
  api.route('/auth', authStatusRoutes);

  // Better Auth owns every other /api/auth/* path.
  api.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

  api.route('/me', meRoutes);
  api.route('/models', modelCatalogRoutes);
  api.route('/threads', threadRoutes);
  api.route('/chat', chatRoutes);
  api.route('/admin', adminRoutes);

  return api;
}
