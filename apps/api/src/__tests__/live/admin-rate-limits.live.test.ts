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

const { lifecycleRoutes } = await import('../../routes/admin/lifecycle.js');
const { getRateLimitSettings } = await import('../../services/lifecycle/settings.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

/** Roles & access saves one role's changed fields at a time. */
describe.skipIf(!available)('live: per-role rate-limit updates', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('rate_limits');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    const actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Admin',
        email: 'admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.use('*', requireAdmin);
    app.route('/lifecycle', lifecycleRoutes);
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  async function put(body: unknown) {
    return app.request('/lifecycle/rate-limits', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('accepts one role and one field, leaving other roles and fields unchanged', async () => {
    const before = await getRateLimitSettings();
    const response = await put({ roles: { restricted: { chatRequestsPerMinute: 5 } } });
    expect(response.status, await response.clone().text()).toBe(200);

    const after = await getRateLimitSettings();
    expect(after.roles.restricted).toEqual({
      ...before.roles.restricted,
      chatRequestsPerMinute: 5,
    });
    expect(after.roles.user).toEqual(before.roles.user);
    expect(after.roles.admin).toEqual(before.roles.admin);
  });

  it('still rejects unknown roles and fields', async () => {
    expect((await put({ roles: { owner: { chatRequestsPerMinute: 5 } } })).status).toBe(422);
    expect((await put({ roles: { user: { chatRequestsPerMinute: 0 } } })).status).toBe(422);
  });
});
