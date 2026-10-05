import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import { loadEnv } from '../../config/env.js';
import { safeCompare } from '../../lib/crypto.js';
import { registerCollectedGauges } from './collected.js';
import { httpRequestDuration, httpRequests, renderMetrics } from './metrics.js';
import { registerOperationalGauges } from './operational.js';
import { markRequestStart } from './request-timing.js';
import { extractTraceContext, tracingEnabled, withSpan } from './tracing.js';

/**
 * The route template that handled a request (`/api/threads/:id`), never the
 * raw path, so ids cannot become metric labels or span names. Requests no
 * handler claimed are grouped as `unmatched`.
 *
 * The router returns every route that matches, in registration order, and
 * only the first handler runs: `GET /api/threads/search` matches both
 * `/search` and the later `/:id`. So this is the handler that ran (Hono
 * records the index of the deepest one reached), or, when a middleware
 * answered first (a 401 from `requireAuth`), the first handler after it,
 * the one the request was for. Middleware (`use`) routes have method `ALL`.
 */
function routeTemplate(c: Parameters<typeof matchedRoutes>[0]): string {
  const routes = matchedRoutes(c);
  const from = Math.max(0, c.req.routeIndex ?? 0);
  const handler = routes.slice(from).find((route) => route.method !== 'ALL');
  const path = handler?.path;
  return path && path !== '/*' && path !== '*' ? path : 'unmatched';
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Counts and times every request, and opens a server span when tracing is on. */
export const observeRequests = createMiddleware(async (c, next) => {
  const started = performance.now();
  markRequestStart(c.req.raw, started);
  const method = METHODS.has(c.req.method) ? c.req.method : 'OTHER';

  const finish = (status: number) => {
    const route = routeTemplate(c);
    httpRequests.inc({ method, route, status: String(status) });
    httpRequestDuration.observe({ method, route }, (performance.now() - started) / 1000);
    return route;
  };

  if (!tracingEnabled()) {
    try {
      await next();
    } finally {
      finish(c.res.status);
    }
    return;
  }

  await withSpan(
    `${method}`,
    { 'http.request.method': method },
    async (span) => {
      try {
        await next();
      } finally {
        const route = finish(c.res.status);
        span.setAttributes({ 'http.route': route, 'http.response.status_code': c.res.status });
        if (c.res.status >= 500) span.fail(`HTTP ${c.res.status}`);
        // The route template is known only once a handler matched.
        span.rename(`${method} ${route}`);
      }
    },
    { kind: 'server', parent: extractTraceContext(c.req.raw.headers) },
  );
});

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * `GET /metrics`: Prometheus exposition, only when `METRICS_TOKEN` is set and
 * presented as a Bearer token. Not found otherwise, so an instance without a
 * token does not reveal that the endpoint exists.
 */
export const metricsRoutes = new Hono();
registerCollectedGauges();
registerOperationalGauges();

metricsRoutes.get('/', async (c) => {
  const token = loadEnv().METRICS_TOKEN;
  if (!token) return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);

  const header = c.req.header('authorization') ?? '';
  const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? '';
  // Compare digests: equal length, so the comparison time says nothing about the token.
  if (!presented || !safeCompare(digest(presented), digest(token))) {
    c.header('WWW-Authenticate', 'Bearer realm="metrics"');
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'A valid metrics token is required' } },
      401,
    );
  }

  c.header('Cache-Control', 'no-store');
  return c.body(await renderMetrics(), 200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  });
});
