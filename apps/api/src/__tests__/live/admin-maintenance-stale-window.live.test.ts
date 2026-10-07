import { desc, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * A read-only audit entry records the scheduled window that is in effect or
 * still to come, not one that ended long ago and was left in the stored
 * setting (#349): the entry made an auditor think a window was in force while
 * the status and the Maintenance card showed none. Through the real route.
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
const { getSetting, invalidateSettingsCache, updateSetting } = await import(
  '../../services/settings.js'
);
const { errorHandler } = await import('../../middleware/error-handler.js');

const HOUR = 60 * 60 * 1000;

describe.skipIf(!available)('live: read-only audit entries and an expired window (#349)', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);

  async function put(body: unknown) {
    const response = await app.request('/maintenance', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<{ window: unknown }>;
  }

  async function lastEntry() {
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'maintenance.read_only.update'))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return (entry as NonNullable<typeof entry>).metadata as Record<string, unknown>;
  }

  const storedWindow = async () => (await getSetting('maintenance')).window ?? null;

  beforeAll(async () => {
    live = await createLiveDatabase('maintenance_stale_window');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app.use('*', async (c, next) => {
      c.set('user', {
        id: admin,
        role: 'admin',
        name: 'Admin',
        email: 'maintenance@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/maintenance', maintenanceAdminRoutes);
  });
  beforeEach(() => invalidateSettingsCache());
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('does not record a window that ended, and clears it from the stored setting', async () => {
    // Left by an earlier test of a scheduled window.
    await updateSetting('maintenance', {
      window: {
        startsAt: new Date(Date.now() - 5 * HOUR).toISOString(),
        endsAt: new Date(Date.now() - 4 * HOUR).toISOString(),
        reason: 'Old window',
        announcementId: null,
      },
    });
    invalidateSettingsCache();

    await put({ readOnly: true, reason: 'Fix8 on' });
    expect(await lastEntry()).toMatchObject({
      window: null,
      active: { before: false, after: true },
    });
    expect(await storedWindow()).toBeNull();

    // Turned off again: still none.
    await put({ readOnly: false });
    expect(await lastEntry()).toMatchObject({ window: null });
  });

  it('still records a window that is coming, and one in effect', async () => {
    const startsAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const endsAt = new Date(Date.now() + 3 * HOUR).toISOString();
    await put({ window: { startsAt, endsAt, reason: 'Upcoming', announce: false } });
    expect(await lastEntry()).toMatchObject({ window: { startsAt, endsAt } });

    // A later change keeps it, for it is still to come.
    await put({ reason: 'Fix8 note' });
    expect(await lastEntry()).toMatchObject({ window: { startsAt, endsAt } });
    expect(await storedWindow()).toMatchObject({ startsAt, endsAt });

    // Removing it records none.
    await put({ window: null });
    expect(await lastEntry()).toMatchObject({ window: null });
  });
});
