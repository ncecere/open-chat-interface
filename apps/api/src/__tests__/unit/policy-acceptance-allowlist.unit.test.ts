import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { concretePath, registeredWrites } from '../../../test/registered-writes.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * The acceptable use policy, enforced on the server (#367): every write route
 * the API registers, enumerated from the router itself (and Better Auth's own
 * endpoints behind `/api/auth/*`), is refused with 403
 * POLICY_ACCEPTANCE_REQUIRED for a person who has not accepted the published
 * policy, unless it is on the allowlist, so a route added later cannot slip
 * through. The allowed set is spelled out below: widening it is a visible
 * change.
 *
 * The policy lookup is stubbed here (the live test runs it against the real
 * database); what is under test is which routes the guard lets through.
 */
const state = vi.hoisted(() => ({
  pending: null as null | { id: string; version: number; title: string },
  asked: [] as string[],
}));
vi.mock('../../services/policy-gate.js', () => ({
  pendingPolicyFor: async (userId: string) => {
    state.asked.push(userId);
    return state.pending;
  },
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'maintenance') return {};
    throw new Error(`Nothing but the read-only check may run here (read ${key})`);
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { createApiRoutes } = await import('../../routes/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { auth } = await import('../../auth/index.js');
const { POLICY_ALLOWLIST, policyAllowance } = await import('../../middleware/policy-acceptance.js');

let signedIn = true;
const app = new Hono<AppBindings>();
app.onError(errorHandler);
app.use('*', async (c, next) => {
  c.set(
    'user',
    signedIn
      ? {
          id: 'person-1',
          email: 'person@example.test',
          name: 'Person',
          image: null,
          role: 'user',
          emailVerified: true,
          organizationId: 'org-1',
        }
      : null,
  );
  await next();
});
app.route('/api', createApiRoutes());

const writes = registeredWrites(app, auth);
const key = (write: { method: string; path: string }) => `${write.method} ${write.path}`;

describe('acceptable use policy: every write route is refused unless allowlisted (#367)', () => {
  it('finds the routes (sanity)', () => {
    expect(writes.length).toBeGreaterThan(150);
    for (const expected of [
      'POST /api/chat',
      'POST /api/chat/:threadId/approvals',
      'POST /api/attachments',
      'POST /api/threads',
      'POST /api/projects',
      'POST /api/memory',
      'POST /api/auth/sign-in/email',
      'PATCH /api/admin/settings',
    ])
      expect(writes.map(key)).toContain(expected);
  });

  it('allows exactly these writes before the policy is accepted', () => {
    const allowed = writes
      // Better Auth's and the administration API's many routes are one entry each.
      .filter((write) => policyAllowance(write.method, concretePath(write.path)))
      .map(key)
      .filter((route) => !route.includes('/api/admin/') && !route.includes('/api/auth/'))
      .sort();
    expect(allowed).toMatchInlineSnapshot(`
      [
        "DELETE /api/chat/:threadId/stream",
        "DELETE /api/me/sessions/:id",
        "DELETE /api/share-links/links/:linkId",
        "POST /api/me/delete-account",
        "POST /api/me/onboarding/accept-policy",
        "POST /api/me/sessions/revoke-others",
        "POST /api/me/share-links/revoke-all",
      ]
    `);
    // Identity (Better Auth) and the administration API, as groups.
    const groups = writes
      .filter((write) => policyAllowance(write.method, concretePath(write.path)))
      .map((write) => write.path.split('/').slice(0, 3).join('/'));
    expect(new Set(groups)).toEqual(
      new Set(['/api/auth', '/api/admin', '/api/chat', '/api/me', '/api/share-links']),
    );
    // Every Better Auth write is identity, and every administration write is open.
    for (const write of writes.filter((entry) => entry.path.startsWith('/api/auth/')))
      expect(policyAllowance(write.method, concretePath(write.path)), key(write)).not.toBeNull();
    for (const write of writes.filter((entry) => entry.path.startsWith('/api/admin/')))
      expect(policyAllowance(write.method, concretePath(write.path)), key(write)).not.toBeNull();
  });

  it('has no allowlist entry that matches no route', () => {
    for (const entry of POLICY_ALLOWLIST) {
      expect(
        writes.some(
          (write) =>
            write.method === entry.method &&
            policyAllowance(write.method, concretePath(write.path)) === entry,
        ),
        `${entry.method} ${entry.path}`,
      ).toBe(true);
    }
  });

  it('refuses every other write with 403 POLICY_ACCEPTANCE_REQUIRED, before any work', async () => {
    state.pending = { id: 'policy-3', version: 3, title: 'Acceptable use' };
    const refused = writes.filter(
      (write) => !policyAllowance(write.method, concretePath(write.path)),
    );
    // The writes that use the instance, spelled out: a new one is a visible change.
    expect(refused.map(key).sort()).toMatchInlineSnapshot(`
      [
        "DELETE /api/attachments/:id",
        "DELETE /api/attachments/:id/unsent",
        "DELETE /api/connectors/:id/account",
        "DELETE /api/me/imports/:id",
        "DELETE /api/memory",
        "DELETE /api/memory/:id",
        "DELETE /api/projects/:id",
        "DELETE /api/projects/:id/files/:fileId",
        "DELETE /api/threads/:id",
        "DELETE /api/threads/:id/compaction/failure",
        "DELETE /api/threads/:id/permanent",
        "DELETE /api/threads/:id/unused",
        "DELETE /api/threads/trash",
        "PATCH /api/me/preferences",
        "PATCH /api/memory/:id",
        "PATCH /api/projects/:id",
        "PATCH /api/threads/:id",
        "PATCH /api/threads/:id/messages/:messageId/active",
        "POST /api/artifacts/:id/versions",
        "POST /api/attachments",
        "POST /api/chat",
        "POST /api/chat/:threadId/approvals",
        "POST /api/connectors/:id/connect",
        "POST /api/me/broadcasts/:id/dismiss",
        "POST /api/me/imports",
        "POST /api/me/onboarding/complete",
        "POST /api/me/onboarding/skip",
        "POST /api/memory",
        "POST /api/memory/undo",
        "POST /api/projects",
        "POST /api/projects/:id/files",
        "POST /api/share-links/threads/:threadId",
        "POST /api/threads",
        "POST /api/threads/:id/branches",
        "POST /api/threads/:id/compact",
        "POST /api/threads/:id/forks",
        "POST /api/threads/:id/restore",
        "PUT /api/memory/settings",
      ]
    `);
    for (const write of refused) {
      const response = await app.request(concretePath(write.path), {
        method: write.method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, key(write)).toBe(403);
      const body = (await response.json()) as {
        error: { code: string; message: string; details: { policy: { version: number } } };
      };
      expect(body.error.code, key(write)).toBe('POLICY_ACCEPTANCE_REQUIRED');
      expect(body.error.message).toContain('acceptable use policy (version 3)');
      expect(body.error.details.policy).toMatchObject({ id: 'policy-3', version: 3 });
    }
  });

  it('lets an allowlisted write through to its own handler', async () => {
    state.pending = { id: 'policy-3', version: 3, title: 'Acceptable use' };
    // Not a valid body: the handler's own validation answers, not the guard.
    const response = await app.request('/api/me/onboarding/accept-policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(422);
  });

  it('never looks at the policy for a read, nor for a request without a session', async () => {
    state.pending = { id: 'policy-3', version: 3, title: 'Acceptable use' };
    state.asked.length = 0;
    expect((await app.request('/api/health')).status).not.toBe(403);
    expect((await app.request('/api/threads')).status).not.toBe(403);
    signedIn = false;
    const anonymous = await app.request('/api/threads', { method: 'POST', body: '{}' });
    signedIn = true;
    expect(anonymous.status).toBe(401);
    expect(state.asked).toEqual([]);
  });

  it('lets everything through when nothing is owed', async () => {
    state.pending = null;
    const response = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).not.toBe(403);
  });
});
