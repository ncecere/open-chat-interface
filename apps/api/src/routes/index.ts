import { SAML_NOT_SUPPORTED_MESSAGE } from '@oci/shared';
import { Hono } from 'hono';
import { auth } from '../auth/index.js';
import { loadEnv } from '../config/env.js';
import { authRateLimitMiddleware } from '../middleware/auth-rate-limit.js';
import type { AppBindings } from '../middleware/context.js';
import { policyAcceptanceGuard } from '../middleware/policy-acceptance.js';
import { readOnlyGuard } from '../middleware/read-only.js';
import { adminRoutes } from './admin/index.js';
import { artifactRoutes } from './artifacts.js';
import { attachmentRoutes } from './attachments.js';
import { authStatusRoutes } from './auth-status.js';
import { brandingRoutes } from './branding.js';
import { chatRoutes } from './chat.js';
import { connectorRoutes } from './connectors.js';
import { healthRoutes } from './health.js';
import { maintenanceRoutes } from './maintenance.js';
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

  // Read-only maintenance mode (v0.11): first, so a write it refuses is
  // refused before anything else is done with it, and a route added later is
  // refused by default (middleware/read-only.ts has the allowlist).
  api.use('*', readOnlyGuard);
  // The acceptable use policy (#367): a person who has not accepted the
  // published version cannot write, except what its allowlist names.
  api.use('*', policyAcceptanceGuard);

  api.route('/health', healthRoutes);
  // Unauthenticated: whether writes are refused now, for the banner.
  api.route('/maintenance', maintenanceRoutes);
  api.route('/auth', authStatusRoutes);
  // Unauthenticated: the sign-in page renders the logo before anyone signs in.
  api.route('/branding', brandingRoutes);

  // Sign-in, sign-up, password reset and verification: RATE_LIMIT_AUTH_PER_MINUTE.
  api.use('/auth/*', authRateLimitMiddleware);

  /**
   * Answers 404 for all of Better Auth's admin endpoints (/api/auth/admin/*).
   * Every account change an administrator makes goes through OCI's own routes
   * under /api/admin/users, which record it in the audit log with before and
   * after, send webhooks, refuse self-demotion and removing the last
   * administrator, and respect legal holds. The plugin's endpoints did the
   * same changes, and impersonation, with none of that (QA walk 5); the web
   * app never calls them. The plugin itself stays: it supplies roles, bans
   * and the server-side createUser the API uses.
   */
  const managedInPeople = {
    code: 'NOT_FOUND',
    message: 'Manage accounts under People → Users.',
    error: { code: 'NOT_FOUND', message: 'Manage accounts under People → Users.' },
  };
  api.all('/auth/admin/*', (c) => c.json(managedInPeople, 404));

  /**
   * Answers 404 for every SAML endpoint (/api/auth/sso/saml2/*). SAML sign-in
   * was removed (#53), but the SSO plugin still ships its routes (assertion
   * consumer, metadata, logout), so without this they would keep answering for
   * a provider row left over from an earlier release. Registered before the
   * catch-all below, like the admin one.
   */
  const samlRemoved = {
    code: 'NOT_FOUND',
    message: SAML_NOT_SUPPORTED_MESSAGE,
    error: { code: 'NOT_FOUND', message: SAML_NOT_SUPPORTED_MESSAGE },
  };
  api.all('/auth/sso/saml2/*', (c) => c.json(samlRemoved, 404));

  /**
   * Better Auth owns every other /api/auth/* path; sign-in, sign-up, password
   * reset and verification are limited per client address and per account
   * (RATE_LIMIT_AUTH_PER_MINUTE: 429 with Retry-After).
   */
  api.on(['GET', 'POST'], '/auth/*', async (c) => {
    const response = await auth.handler(c.req.raw);

    /*
     * Turn a refused SSO sign-in into a redirect back to the sign-in page.
     *
     * The OIDC callback returns the body of an APIError, so a refusal would
     * render as raw JSON on a blank page.
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
  api.route('/artifacts', artifactRoutes);
  api.route('/share-links', shareLinkRoutes);
  api.route('/connectors', connectorRoutes);
  api.route('/admin', adminRoutes);

  return api;
}
