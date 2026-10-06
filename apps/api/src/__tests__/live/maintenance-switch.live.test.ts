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

/**
 * The read-only switch on one replica (#222): an expected end in the past is
 * refused, and turning read-only off drops its reason and end, so the next
 * switch-on, or a scheduled window with no reason of its own, does not show
 * an old one. (read-only.live.test.ts covers several replicas, with Redis.)
 */
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

const { maintenanceAdminRoutes } = await import('../../routes/admin/maintenance.js');
const { readOnlyStatus } = await import('../../services/maintenance/read-only.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: the read-only switch (#222)', () => {
  let live: LiveDatabase;
  let admin: string;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin,
      role: 'admin',
      name: 'Admin',
      email: 'switch@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/maintenance', maintenanceAdminRoutes);

  const put = (body: unknown) =>
    app.request('/maintenance', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const view = async () =>
    (await (await app.request('/maintenance')).json()) as Record<string, unknown>;

  beforeAll(async () => {
    live = await createLiveDatabase('maintenance_switch');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('refuses an expected end in the past', async () => {
    const past = new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString();
    const refused = await put({ readOnly: true, reason: 'Walk3 check', until: past });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain('Choose a time later than now.');
    expect((await readOnlyStatus()).active).toBe(false);
  });

  it('forgets the reason and end when read-only is turned off', async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    expect((await put({ readOnly: true, reason: 'Walk2 resilience test', until })).status).toBe(
      200,
    );
    expect(await view()).toMatchObject({ reason: 'Walk2 resilience test', until });
    expect((await put({ readOnly: false })).status).toBe(200);
    expect(await view()).toMatchObject({ readOnly: false, reason: null, until: null });

    // A window scheduled later, with no reason of its own, shows none.
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const scheduled = await put({
      window: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), announce: false },
    });
    expect(scheduled.status).toBe(200);
    const during = await readOnlyStatus(startsAt.getTime() + 1_000);
    expect(during).toMatchObject({ active: true, source: 'schedule', reason: null });
  });
});
