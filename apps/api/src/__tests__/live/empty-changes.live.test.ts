import { randomUUID } from 'node:crypto';
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
 * A PATCH whose body holds no field the route knows is a 422 that names the
 * fields, not a 500 from an UPDATE with nothing to set (#341). The real routes
 * and PostgreSQL; the routes are those whose bodies are all optional and are
 * written straight to a row.
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

const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { meRoutes } = await import('../../routes/me.js');
const { modelRoutes } = await import('../../routes/admin/models.js');
const { userRoutes } = await import('../../routes/admin/users.js');
const { ssoRoutes } = await import('../../routes/admin/sso.js');

describe.skipIf(!available)('live: a change with nothing to change', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let adminId: string;
  let modelId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('empty_changes');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    adminId = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'Empty changes' })
      .returning();
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId: provider!.id,
        slug: 'empty-changes',
        upstreamModelId: 'empty-changes',
        displayName: 'Empty changes',
      })
      .returning();
    modelId = model!.id;
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: adminId,
        role: 'admin',
        name: 'Admin',
        email: 'empty-changes@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.use('/admin/*', requireAdmin);
    app.route('/me', meRoutes);
    app.route('/admin/models', modelRoutes);
    app.route('/admin/users', userRoutes);
    app.route('/admin/sso', ssoRoutes);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  const send = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function refused(response: Response) {
    const text = await response.clone().text();
    expect(response.status, text).toBe(422);
    const { error } = JSON.parse(text) as { error: { code: string; message: string } };
    expect(error.code).toBe('VALIDATION_FAILED');
    return error.message;
  }

  it.each([
    ['PATCH', '/me/preferences', ['theme', 'density']],
    ['PATCH', () => `/admin/models/${modelId}`, ['displayName', 'enabled']],
    ['PATCH', () => `/admin/users/${adminId}`, ['name', 'role', 'banned']],
    ['PATCH', `/admin/sso/providers/${randomUUID()}`, ['label', 'enabled']],
  ] as const)(
    '%s %s with no known field answers 422 naming the fields',
    async (method, path, fields) => {
      const url = typeof path === 'function' ? path() : path;
      for (const body of [{}, { foo: 1 }, { memoryEnabled: false }]) {
        const message = await refused(await send(method, url, body));
        expect(message).toMatch(/^Send at least one change: /);
        for (const field of fields) expect(message).toContain(field);
      }
    },
  );

  it('a body that is not an object is a 422 too', async () => {
    expect(await refused(await send('PATCH', '/me/preferences', 'theme'))).toBeTruthy();
    expect(await refused(await send('PATCH', '/me/preferences', null))).toBeTruthy();
  });

  it('a known field still saves', async () => {
    const saved = await send('PATCH', '/me/preferences', { theme: 'dark' });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const model = await send('PATCH', `/admin/models/${modelId}`, { displayName: 'Renamed' });
    expect(model.status, await model.clone().text()).toBeLessThan(300);
    const [stored] = await live.db.select().from(schema.model).where(eq(schema.model.id, modelId));
    expect(stored?.displayName).toBe('Renamed');
  });
});
