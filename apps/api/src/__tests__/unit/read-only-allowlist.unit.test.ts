import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Read-only maintenance mode (v0.11 design, section 9): every write route the
 * API registers, enumerated from the router itself (and Better Auth's own
 * endpoints behind `/api/auth/*`), is refused with 423 READ_ONLY unless it is
 * on the allowlist, so a route added later cannot slip through. The allowed
 * set is spelled out below: widening it is a visible change.
 */
const state = vi.hoisted(() => ({
  maintenance: {} as Record<string, unknown>,
  reads: 0,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'maintenance') {
      state.reads++;
      return state.maintenance;
    }
    throw new Error(`Nothing but the read-only check may run here (read ${key})`);
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { createApiRoutes } = await import('../../routes/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { auth } = await import('../../auth/index.js');
const { READ_ONLY_ALLOWLIST, readOnlyAllowance, readOnlyMessage } = await import(
  '../../middleware/read-only.js'
);

const app = new Hono<AppBindings>();
app.onError(errorHandler);
app.route('/api', createApiRoutes());

const READS = new Set(['GET', 'HEAD', 'OPTIONS', 'ALL']);
const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Better Auth's endpoints that change something, under the `/api/auth/*` handler. */
function betterAuthWrites(): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];
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
function registeredWrites(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const writes: Array<{ method: string; path: string }> = [];
  const add = (method: string, path: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    writes.push({ method, path });
  };
  for (const route of app.routes) {
    if (READS.has(route.method)) continue;
    if (route.path === '/api/auth/*') {
      for (const endpoint of betterAuthWrites())
        if (endpoint.method === route.method) add(endpoint.method, endpoint.path);
      continue;
    }
    add(route.method, route.path);
  }
  return writes;
}

/** A concrete URL for a route pattern. */
const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'id-1').replace(/\*$/, 'anything');

const until = new Date(Date.now() + 3_600_000).toISOString();

afterEach(() => {
  state.maintenance = {};
});

describe('read-only mode: every write route is refused unless allowlisted', () => {
  const writes = registeredWrites();

  it('finds the routes (sanity)', () => {
    // Thread, chat, upload, admin settings and Better Auth writes are all there.
    expect(writes.length).toBeGreaterThan(150);
    for (const expected of [
      'POST /api/chat',
      'POST /api/attachments',
      'PATCH /api/threads/:id',
      'PATCH /api/admin/settings',
      'POST /api/auth/sign-up/email',
      'POST /api/auth/sign-in/email',
    ])
      expect(writes.map((write) => `${write.method} ${write.path}`)).toContain(expected);
    // No handler is registered for every method: a route like that would be
    // listed as ALL and could not be checked here.
    expect(
      app.routes.filter(
        (route) => route.method === 'ALL' && !route.path.endsWith('*') && route.path !== '/api',
      ),
    ).toEqual([]);
  });

  it('allows exactly these writes while read-only', () => {
    const allowed = writes
      .filter((write) => readOnlyAllowance(write.method, concrete(write.path)))
      .map((write) => `${write.method} ${write.path}`)
      .sort();
    expect(allowed).toMatchInlineSnapshot(`
      [
        "DELETE /api/chat/:threadId/stream",
        "DELETE /api/me/sessions/:id",
        "POST /api/admin/backups/run",
        "POST /api/admin/compliance/run",
        "POST /api/admin/users/:id/revoke-sessions",
        "POST /api/auth/accept-invite/validate",
        "POST /api/auth/sign-in/email",
        "POST /api/auth/sign-in/social",
        "POST /api/auth/sign-in/sso",
        "POST /api/auth/sign-out",
        "POST /api/auth/sso/saml2/callback/:providerId",
        "POST /api/auth/sso/saml2/logout/:providerId",
        "POST /api/auth/sso/saml2/sp/acs/:providerId",
        "POST /api/auth/sso/saml2/sp/slo/:providerId",
        "POST /api/me/broadcasts/:id/dismiss",
        "POST /api/me/onboarding/accept-policy",
        "POST /api/me/onboarding/complete",
        "POST /api/me/onboarding/skip",
        "POST /api/me/sessions/revoke-others",
        "PUT /api/admin/maintenance",
      ]
    `);
  });

  it('has no allowlist entry that matches no route', () => {
    for (const entry of READ_ONLY_ALLOWLIST) {
      expect(
        writes.some(
          (write) =>
            write.method === entry.method &&
            readOnlyAllowance(write.method, concrete(write.path)) === entry,
        ),
        `${entry.method} ${entry.path}`,
      ).toBe(true);
    }
  });

  it('refuses every other write with 423 READ_ONLY and Retry-After, before any work', async () => {
    state.maintenance = { readOnly: true, reason: 'Database upgrade', until };
    const refused = writes.filter(
      (write) => !readOnlyAllowance(write.method, concrete(write.path)),
    );
    expect(refused.length).toBeGreaterThan(130);
    for (const write of refused) {
      const response = await app.request(concrete(write.path), {
        method: write.method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, `${write.method} ${write.path}`).toBe(423);
      const body = (await response.json()) as {
        error: { code: string; message: string; details: { readOnly: { until: string } } };
      };
      expect(body.error.code).toBe('READ_ONLY');
      expect(body.error.details.readOnly).toMatchObject({
        active: true,
        source: 'administrator',
        reason: 'Database upgrade',
        until,
      });
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(3_500);
      expect(retryAfter).toBeLessThanOrEqual(3_600);
      expect(response.headers.get('x-oci-read-only')).toBe('administrator');
    }
  });

  it('lets an allowlisted write through to its handler (the switch itself)', async () => {
    state.maintenance = { readOnly: true };
    // No session in this app: the handler's own guard answers, not read-only.
    const response = await app.request('/api/admin/maintenance', {
      method: 'PUT',
      body: '{"readOnly":false}',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
  });

  it('allows a manual backup only while backups keep running', async () => {
    state.maintenance = { readOnly: true, keepRunningJobs: ['compliance.export'] };
    expect((await app.request('/api/admin/backups/run', { method: 'POST' })).status).toBe(423);
    expect((await app.request('/api/admin/compliance/run', { method: 'POST' })).status).toBe(401);
  });

  it('serves reads and leaves writes alone when it is off', async () => {
    state.maintenance = { readOnly: true };
    const reads = state.reads;
    expect((await app.request('/api/threads')).status).toBe(401);
    // A read never even looks at the setting.
    expect(state.reads).toBe(reads);
    state.maintenance = {};
    expect((await app.request('/api/threads', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('omits Retry-After when the end is not known, and says so in words', async () => {
    state.maintenance = { readOnly: true, reason: 'Moving the database.' };
    const response = await app.request('/api/threads', { method: 'POST', body: '{}' });
    expect(response.status).toBe(423);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      'This service is read-only for maintenance (Moving the database). You can read, search and export, but changes cannot be saved until maintenance ends.',
    );
    expect(
      readOnlyMessage({
        active: true,
        source: 'schedule',
        reason: null,
        until: '2026-10-04T14:30:00.000Z',
        window: null,
      }),
    ).toContain('expected 2026-10-04 14:30 UTC');
  });

  it('lets writes through when the setting cannot be read', async () => {
    state.maintenance = null as unknown as Record<string, unknown>;
    expect((await app.request('/api/threads', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
