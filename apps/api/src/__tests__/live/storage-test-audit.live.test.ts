import { eq, schema } from '@oci/db';
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
 * Settings → Storage → Test connection (#368): a failed test used to leave no
 * audit entry at all (it threw before the one for a pass). Now it records where
 * it went and why, without the address's credentials or query.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
}));
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

describe.skipIf(!available)('live: testing object storage leaves an audit entry (#368)', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  const send = (method: string, path: string, body: unknown) =>
    app.request(`/settings${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    live = await createLiveDatabase('storage_test_audit');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Storage tester',
        email: 'storage-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/settings', settingsRoutes);
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('records a failed test with its target and reason, and no credential', async () => {
    invalidateSettingsCache();
    // Nothing listens on port 9.
    const saved = await send('PATCH', '', {
      storage: {
        s3: {
          bucket: 'walk-bucket',
          region: 'us-east-1',
          endpoint: 'http://127.0.0.1:9',
          accessKeyId: 'AKIAFAKEFAKEFAKE1234',
          secretAccessKey: 'super-secret-storage-key-368',
          forcePathStyle: true,
        },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const response = await send('POST', '/storage/test', { mode: 'write' });
    expect(response.status).toBe(502);

    const entries = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'storage.test'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual({
      ok: false,
      mode: 'write',
      bucket: 'walk-bucket',
      endpoint: 'http://127.0.0.1:9',
      reason: expect.stringMatching(/\S/),
    });
    expect(JSON.stringify(entries)).not.toContain('super-secret-storage-key-368');
    expect(JSON.stringify(entries)).not.toContain('AKIAFAKEFAKEFAKE1234');
  });
});
