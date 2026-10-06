import { eq, schema } from '@oci/db';
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
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function adminApp(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Storage admin',
      email: 'storage-admin@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/lifecycle', lifecycleRoutes);
  return app;
}

describe.skipIf(!available)('live: storage allowances by role', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  const put = (role: string, body: unknown) =>
    app.request(`/lifecycle/storage-policies/${role}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const policies = () => live.db.select().from(schema.storagePolicy);
  const audit = (action: string) =>
    live.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    live = await createLiveDatabase('storage_policies');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    app = adminApp(await seedUser(live.db, state.organizationId, { role: 'admin' }));
  });
  beforeEach(async () => {
    await live.db.delete(schema.storagePolicy);
    await live.db.delete(schema.auditLog);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('refuses a body naming another role than the URL, and changes nothing (#141)', async () => {
    const response = await put('restricted', { role: 'user', enabled: true, maxFileCount: 5 });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { details: unknown } };
    expect(body.error.details).toEqual([
      expect.objectContaining({ path: ['role'], message: expect.stringContaining('restricted') }),
    ]);
    expect(await policies()).toEqual([]);
    expect(await audit('storage.policy.update')).toEqual([]);
  });

  it('updates the role in the URL, with or without the role in the body (#141)', async () => {
    expect((await put('restricted', { enabled: true, maxFileCount: 5 })).status).toBe(200);
    expect((await put('user', { role: 'user', enabled: true, maxFileCount: 9 })).status).toBe(200);
    const saved = await policies();
    expect(saved.map(({ role, maxFileCount }) => ({ role, maxFileCount }))).toEqual(
      expect.arrayContaining([
        { role: 'restricted', maxFileCount: 5 },
        { role: 'user', maxFileCount: 9 },
      ]),
    );
    expect((await audit('storage.policy.update')).map((entry) => entry.targetId).sort()).toEqual([
      'restricted',
      'user',
    ]);
  });

  it('answers 404 for a URL that names no role', async () => {
    expect((await put('owner', { enabled: true })).status).toBe(404);
    expect(await policies()).toEqual([]);
  });
});
