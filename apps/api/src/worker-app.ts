import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import type { AppBindings } from './middleware/context.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { metricsRoutes, observeRequests } from './services/observability/http.js';

/**
 * What a worker (OCI_ROLE=worker) serves on API_PORT: liveness, readiness and
 * Prometheus metrics, nothing else. Probes and scrapers use the same paths as
 * on an API replica; every other path answers 404, so a worker mistakenly put
 * behind the web proxy is obvious at once rather than half working.
 */
export function createWorkerApp() {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.use('*', observeRequests);
  app.route('/metrics', metricsRoutes);
  app.route('/api/health', healthRoutes);
  app.onError(errorHandler);
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'This is an OCI worker (OCI_ROLE=worker); it serves no API routes.',
        },
      },
      404,
    ),
  );
  return app;
}
