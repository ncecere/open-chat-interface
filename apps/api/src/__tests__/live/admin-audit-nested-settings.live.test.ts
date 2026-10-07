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
 * A settings update's audit entry shows each changed value as it was and as it
 * became, for settings that live inside a branch (storage, email) as well as
 * for flat ones (#344): through the real settings route and stored branches.
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

const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');

describe.skipIf(!available)('live: audit entries for nested settings line up (#344)', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);

  async function patch(body: unknown) {
    const response = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    invalidateSettingsCache();
  }

  async function lastChanges() {
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return ((entry as NonNullable<typeof entry>).metadata as { changes: unknown[] }).changes;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('audit_nested_settings');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app.use('*', async (c, next) => {
      c.set('user', {
        id: admin,
        role: 'admin',
        name: 'Admin',
        email: 'nested@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/settings', settingsRoutes);
  });
  beforeEach(() => invalidateSettingsCache());
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('records the one storage field that changed with its own before', async () => {
    await patch({ storage: { maxFilesPerMessage: 7 } });
    await patch({ storage: { maxFilesPerMessage: 10 } });
    expect(await lastChanges()).toEqual([
      { key: 'storage.maxFilesPerMessage', before: 7, after: 10 },
    ]);
  });

  it('records an email port change as the port before and after, and a password only by presence', async () => {
    await patch({
      smtp: { host: 'mail.example.test', port: 1025, fromAddress: 'oci@example.test' },
    });
    await patch({
      smtp: {
        host: 'mail.example.test',
        port: 1026,
        fromAddress: 'oci@example.test',
        password: 'walk-secret-password',
      },
    });
    const changes = await lastChanges();
    expect(changes).toEqual([
      { key: 'smtp.port', before: 1025, after: 1026 },
      { key: 'smtp.password', before: '[unset]', after: '[set]' },
    ]);
    expect(JSON.stringify(changes)).not.toContain('walk-secret-password');
    // The form sends everything it shows: only what changed is recorded.
    await patch({
      smtp: { host: 'mail.example.test', port: 1025, fromAddress: 'oci@example.test' },
    });
    expect(await lastChanges()).toEqual([{ key: 'smtp.port', before: 1026, after: 1025 }]);
  });
});
