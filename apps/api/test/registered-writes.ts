import type { Hono } from 'hono';

/**
 * Every write route an app registers, enumerated from the router itself (and
 * Better Auth's own endpoints behind `/api/auth/*`), for the tests that check
 * a guard treats each one: the read-only allowlist and the acceptable use
 * policy's. A route added later shows up here without anyone remembering to.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS', 'ALL']);
const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface RegisteredWrite {
  method: string;
  path: string;
}

/** Better Auth's endpoints that change something, under the `/api/auth/*` handler. */
function betterAuthWrites(auth: { api: object }): RegisteredWrite[] {
  const found: RegisteredWrite[] = [];
  for (const endpoint of Object.values(auth.api) as Array<{
    path?: string;
    options?: { method?: string | string[] };
  }>) {
    if (typeof endpoint?.path !== 'string') continue;
    const methods = [endpoint.options?.method ?? []].flat();
    for (const method of methods) {
      if (WRITES.includes(method)) found.push({ method, path: `/api/auth${endpoint.path}` });
    }
  }
  return found;
}

/** Every registered write: method and route pattern, Better Auth's expanded. */
export function registeredWrites(
  // biome-ignore lint/suspicious/noExplicitAny: any app's bindings
  app: Hono<any>,
  auth: { api: object },
): RegisteredWrite[] {
  const seen = new Set<string>();
  const writes: RegisteredWrite[] = [];
  const add = (method: string, path: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    writes.push({ method, path });
  };
  for (const route of app.routes) {
    if (READS.has(route.method)) continue;
    if (route.path === '/api/auth/*') {
      for (const endpoint of betterAuthWrites(auth))
        if (endpoint.method === route.method) add(endpoint.method, endpoint.path);
      continue;
    }
    add(route.method, route.path);
  }
  return writes;
}

/** A concrete URL for a route pattern. */
export const concretePath = (path: string) =>
  path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'id-1').replace(/\*$/, 'anything');

/**
 * Every route an app registers, reads included, for the guards that apply to
 * all methods (the two-step verification gate: a password-only session must not
 * read conversations either). Better Auth's endpoints behind `/api/auth/*` are
 * expanded like `registeredWrites`; `ALL` routes (the 404s for endpoints OCI
 * does not expose) are reported once as `ALL`.
 */
export function registeredRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: any app's bindings
  app: Hono<any>,
  auth: { api: object },
): RegisteredWrite[] {
  const seen = new Set<string>();
  const routes: RegisteredWrite[] = [];
  const add = (method: string, path: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path });
  };
  for (const route of app.routes) {
    // Middleware is registered as `ALL` with a wildcard path; skip it, keep real 404 handlers.
    if (route.method === 'ALL' && route.path.endsWith('*') && !route.path.includes('/auth/'))
      continue;
    if (route.path === '/api/auth/*') {
      for (const endpoint of betterAuthEndpoints(auth))
        if (endpoint.method === route.method) add(endpoint.method, endpoint.path);
      continue;
    }
    add(route.method, route.path);
  }
  return routes;
}

/** Better Auth's endpoints under `/api/auth/*`, every method (the HTTP handler answers GET and POST). */
function betterAuthEndpoints(auth: { api: object }): RegisteredWrite[] {
  const found: RegisteredWrite[] = [];
  for (const endpoint of Object.values(auth.api) as Array<{
    path?: string;
    options?: { method?: string | string[] };
  }>) {
    if (typeof endpoint?.path !== 'string') continue;
    const methods = [endpoint.options?.method ?? []].flat();
    for (const method of methods) {
      // The router answers only GET and POST under the catch-all.
      if (method === 'GET' || method === 'POST')
        found.push({ method, path: `/api/auth${endpoint.path}` });
    }
  }
  return found;
}
