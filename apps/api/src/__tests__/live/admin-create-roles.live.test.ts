import { randomUUID } from 'node:crypto';
import { eq, schema } from '@oci/db';
import { USER_ROLES, type UserRole } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../auth/policy.js', () => ({ isEmailVerificationEnforced: async () => false }));
// Stand in only for Better Auth's built-in admin/user creation; the real route,
// OCI role assignment, queries, audit writes and method guard use PostgreSQL.
vi.mock('../../auth/index.js', () => ({
  auth: {
    api: {
      createUser: async ({ body }: { body: { email: string; name: string; role: string } }) => {
        const db = state.db as LiveDatabase['db'];
        const id = randomUUID();
        await db.insert(schema.user).values({
          id,
          email: body.email,
          name: body.name,
          role: body.role,
          organizationId: state.organizationId,
        });
        return { user: { id } };
      },
    },
  },
}));

const { userRoutes } = await import('../../routes/admin/users.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function appFor(id: string, role: UserRole) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id,
      role,
      name: 'Review admin',
      email: 'review@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/users', userRoutes);
  return app;
}

describe.skipIf(!available)('live: administrator-created OCI roles', () => {
  let live: LiveDatabase;
  let actorId: string;
  beforeAll(async () => {
    live = await createLiveDatabase('create_roles');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    actorId = await seedUser(live.db, state.organizationId, { role: 'admin' });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it.each(USER_ROLES)('persists %s through the actual route and read-back', async (role) => {
    const app = appFor(actorId, 'admin');
    const response = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${role}@example.test`,
        name: `Review ${role}`,
        password: 'Test-only-password-123!',
        role,
      }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const detail = await app.request(`/users/${id}`);
    expect(await detail.json()).toMatchObject({ user: { role } });
    const [stored] = await live.db.select().from(schema.user).where(eq(schema.user.id, id));
    expect(stored?.role).toBe(role);
    expect(stored?.emailVerified).toBe(true);
    const [event] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, id));
    expect(event?.metadata).toMatchObject({ role });
    if (role === 'auditor') {
      const auditor = appFor(id, 'auditor');
      expect((await auditor.request('/users')).status).toBe(200);
      expect(
        (
          await auditor.request(`/users/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'admin' }),
          })
        ).status,
      ).toBe(403);
    }
  });
});
