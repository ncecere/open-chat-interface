import { and, eq, schema } from '@oci/db';
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

const { modelRoutes } = await import('../../routes/admin/models.js');
const { reportRoutes } = await import('../../routes/admin/reports.js');
const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function adminApp(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Partial update admin',
      email: 'partial-admin@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/models', modelRoutes);
  app.route('/reports', reportRoutes);
  app.route('/settings', settingsRoutes);
  return app;
}

async function send(app: Hono<AppBindings>, method: string, path: string, body: unknown) {
  const response = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response;
}

/**
 * The admin UI sends one field at a time. These cases reproduce a write that
 * filled unsent fields with schema defaults and overwrote stored values.
 */
describe.skipIf(!available)('live: partial administrative updates', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let providerId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_partial');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    app = adminApp(await seedUser(live.db, state.organizationId, { role: 'admin' }));
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'No requests' })
      .returning();
    providerId = provider!.id;
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('changes only the sent model field', async () => {
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId,
        slug: 'partial-model',
        upstreamModelId: 'partial-model',
        displayName: 'Partial model',
        capabilities: ['vision', 'reasoning'],
        supportedEfforts: ['low', 'high'],
        visibleToRoles: ['admin'],
        isDefault: true,
        sortOrder: 7,
      })
      .returning();

    await send(app, 'PATCH', `/models/${model!.id}`, { enabled: false });
    await send(app, 'PATCH', `/models/${model!.id}`, { displayName: 'Renamed model' });

    const [stored] = await live.db
      .select()
      .from(schema.model)
      .where(eq(schema.model.id, model!.id));
    expect(stored).toMatchObject({
      enabled: false,
      displayName: 'Renamed model',
      capabilities: ['vision', 'reasoning'],
      supportedEfforts: ['low', 'high'],
      visibleToRoles: ['admin'],
      isDefault: true,
      sortOrder: 7,
    });
  });

  it('leaves exactly one default when defaults are changed concurrently', async () => {
    const created = await live.db
      .insert(schema.model)
      .values(
        Array.from({ length: 6 }, (_, index) => ({
          organizationId: state.organizationId,
          providerId,
          slug: `default-race-${index}`,
          upstreamModelId: `default-race-${index}`,
          displayName: `Default race ${index}`,
        })),
      )
      .returning({ id: schema.model.id });

    await Promise.all(
      created.map((row) => send(app, 'PATCH', `/models/${row.id}`, { isDefault: true })),
    );

    const defaults = await live.db
      .select({ id: schema.model.id })
      .from(schema.model)
      .where(
        and(
          eq(schema.model.organizationId, state.organizationId),
          eq(schema.model.isDefault, true),
        ),
      );
    expect(defaults).toHaveLength(1);
  });

  it('keeps the session lifetime when another setting is saved', async () => {
    await send(app, 'PATCH', '/settings', { sessionLifetimeDays: 14, sessionRefreshDays: 3 });
    await send(app, 'PATCH', '/settings', { colorTheme: 'blue' });

    const [auth] = await live.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(
        and(
          eq(schema.instanceSetting.organizationId, state.organizationId),
          eq(schema.instanceSetting.key, 'auth'),
        ),
      );
    expect(auth?.value).toMatchObject({ sessionLifetimeDays: 14, sessionRefreshDays: 3 });

    const [audit] = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.update'))
      .orderBy(schema.auditLog.createdAt)
      .offset(1)
      .limit(1);
    expect(audit?.metadata).toMatchObject({ keys: ['colorTheme'] });
  });

  it('keeps a report window when the report is paused', async () => {
    const created = await send(app, 'POST', '/reports', {
      name: 'Weekly usage',
      cadence: 'weekly',
      windowDays: 7,
      recipients: ['ops@example.test'],
    });
    const { id } = (await created.json()) as { id: string };

    await send(app, 'PATCH', `/reports/${id}`, { enabled: false });

    const [stored] = await live.db
      .select()
      .from(schema.scheduledReport)
      .where(eq(schema.scheduledReport.id, id));
    expect(stored).toMatchObject({ enabled: false, windowDays: 7, cadence: 'weekly' });
  });
});
