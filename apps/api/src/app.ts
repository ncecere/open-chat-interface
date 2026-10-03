import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { loadEnv } from './config/env.js';
import { type AppBindings, sessionMiddleware } from './middleware/context.js';
import { errorHandler } from './middleware/error-handler.js';
import { createApiRoutes } from './routes/index.js';
import { metricsRoutes, observeRequests } from './services/observability/http.js';
import { APP_VERSION } from './version.js';

export function createApp() {
  const env = loadEnv();
  const app = new Hono<AppBindings>();

  app.use('*', requestId());
  app.use('*', observeRequests);
  // Before the session middleware: a scrape carries a token, not a session.
  // Served at the API root, which the bundled web proxy does not forward.
  app.route('/metrics', metricsRoutes);
  app.use('*', secureHeaders());
  app.use('*', sessionMiddleware);

  app.onError(errorHandler);
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

  app.route('/api', createApiRoutes());

  if (env.NODE_ENV === 'development') {
    app.get('/', (c) => c.json({ name: 'Open Chat Interface API', version: APP_VERSION }));
  }

  return app;
}
