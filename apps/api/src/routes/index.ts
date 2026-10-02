import { Hono } from 'hono';
import { auth } from '../auth/index.js';
import { loadEnv } from '../config/env.js';
import type { AppBindings } from '../middleware/context.js';
import { adminRoutes } from './admin/index.js';
import { attachmentRoutes } from './attachments.js';
import { authStatusRoutes } from './auth-status.js';
import { brandingRoutes } from './branding.js';
import { chatRoutes } from './chat.js';
import { connectorRoutes } from './connectors.js';
import { healthRoutes } from './health.js';
import { meRoutes } from './me.js';
import { memoryRoutes } from './memory.js';
import { modelCatalogRoutes } from './models.js';
import { portabilityRoutes } from './portability.js';
import { projectRoutes } from './projects.js';
import { shareLinkRoutes } from './share-links.js';
import { threadRoutes } from './threads.js';

export function createApiRoutes() {
  const env = loadEnv();

  const api = new Hono<AppBindings>();

  api.route('/health', healthRoutes);
  api.route('/auth', authStatusRoutes);
  // Unauthenticated: the sign-in page renders the logo before anyone signs in.
  api.route('/branding', brandingRoutes);

  // Better Auth owns every other /api/auth/* path.
  api.on(['GET', 'POST'], '/auth/*', async (c) => {
    const response = await auth.handler(c.req.raw);

    /*
     * Turn a refused SSO sign-in into a redirect back to the sign-in page.
     *
     * The SAML callback already redirects on an APIError, but the OIDC one
     * returns the body, so a refusal would render as raw JSON on a blank page.
     * Carrying the reason as a query parameter lets the sign-in page explain
     * it in place of a generic failure.
     */
    if (response.status === 403 && c.req.path.includes('/auth/sso/callback/')) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: string; message?: string } | null;

      if (body?.code === 'ROLE_REQUIRED') {
        const target = new URL('/auth/login', env.APP_URL);
        target.searchParams.set('error', 'role_required');
        if (typeof body.message === 'string') {
          target.searchParams.set('error_description', body.message);
        }
        return c.redirect(target.toString());
      }
    }

    return response;
  });

  api.route('/me', meRoutes);
  api.route('/me', portabilityRoutes);
  api.route('/memory', memoryRoutes);
  api.route('/models', modelCatalogRoutes);
  api.route('/threads', threadRoutes);
  api.route('/projects', projectRoutes);
  api.route('/chat', chatRoutes);
  api.route('/attachments', attachmentRoutes);
  api.route('/share-links', shareLinkRoutes);
  api.route('/connectors', connectorRoutes);
  api.route('/admin', adminRoutes);

  return api;
}
