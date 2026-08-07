import type { UserRole } from '@oci/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/index.js', () => ({ auth: { api: { getSession: vi.fn() } } }));

import { AppError } from '../../lib/errors.js';
import {
  type AppBindings,
  type AuthenticatedUser,
  requireAdmin,
  requireAuth,
} from '../../middleware/context.js';

function guardedApp(role: UserRole | null, guard: typeof requireAuth | typeof requireAdmin) {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    const user: AuthenticatedUser | null = role
      ? {
          id: `${role}-1`,
          email: `${role}@example.test`,
          name: role,
          image: null,
          role,
          emailVerified: true,
          organizationId: 'organization-1',
        }
      : null;
    c.set('user', user);
    c.set('sessionId', user ? 'session-1' : null);
    await next();
  });
  app.get('/', guard, (c) => c.json({ ok: true }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ code: error.code }, error.status);
    }
    throw error;
  });
  return app;
}

describe('integration: HTTP permission guards', () => {
  it('rejects anonymous callers on authenticated endpoints', async () => {
    const response = await guardedApp(null, requireAuth).request('/');
    expect(response.status).toBe(401);
  });

  it.each(['user', 'restricted'] as const)(
    'rejects the %s role on admin endpoints',
    async (role) => {
      const response = await guardedApp(role, requireAdmin).request('/');
      expect(response.status).toBe(403);
    },
  );

  it('allows only the admin role through the admin guard', async () => {
    const response = await guardedApp('admin', requireAdmin).request('/');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
