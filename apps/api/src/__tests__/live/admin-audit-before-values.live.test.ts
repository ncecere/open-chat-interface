import { and, desc, eq, schema } from '@oci/db';
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
 * An update's audit entry says what each value was as well as what it became
 * (#148, #221): model edits, budget edits, overrides, bulk role changes and
 * the read-only switch, through the real routes and services.
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

const { modelRoutes } = await import('../../routes/admin/models.js');
const { quotaRoutes } = await import('../../routes/admin/quotas.js');
const { overrideRoutes } = await import('../../routes/admin/overrides.js');
const { maintenanceAdminRoutes } = await import('../../routes/admin/maintenance.js');
const { applyBulkUserAction } = await import('../../services/admin-users/bulk-actions.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const ADMIN_EMAIL = 'before-values@example.test';

describe.skipIf(!available)('live: audit entries record the previous value (#221)', () => {
  let live: LiveDatabase;
  let admin: string;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin,
      role: 'admin',
      name: 'Admin',
      email: ADMIN_EMAIL,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/models', modelRoutes);
  app.route('/quotas', quotaRoutes);
  app.route('/users', overrideRoutes);
  app.route('/maintenance', maintenanceAdminRoutes);

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async function lastEntry(action: string) {
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return entry?.metadata as Record<string, unknown>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('audit_before_values');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, state.organizationId, { role: 'admin', email: ADMIN_EMAIL });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('records a model rename and which way a switch went', async () => {
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'P' })
      .returning();
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId: state.organizationId,
        providerId: provider!.id,
        slug: 'walk3-model',
        upstreamModelId: 'walk3-model',
        displayName: 'Walk3 model',
        visibleToRoles: ['admin'],
      })
      .returning();

    await send('PATCH', `/models/${model!.id}`, { displayName: 'Walk3 model renamed' });
    expect(await lastEntry('model.update')).toMatchObject({
      slug: 'walk3-model',
      fields: ['displayName'],
      changes: [{ key: 'displayName', before: 'Walk3 model', after: 'Walk3 model renamed' }],
    });

    await send('PATCH', `/models/${model!.id}`, { enabled: false });
    expect((await lastEntry('model.update')).changes).toEqual([
      { key: 'enabled', before: true, after: false },
    ]);
  });

  it('records a budget edit’s previous limit, window and roles, and an override’s', async () => {
    const policy = {
      name: 'Walk3 budget',
      metric: 'messages',
      limitValue: 100,
      windowKind: 'daily',
      timezone: 'UTC',
      roles: ['user'],
    };
    const { id } = (await send('POST', '/quotas', policy)) as { id: string };
    await send('PUT', `/quotas/${id}`, {
      ...policy,
      limitValue: 250,
      windowKind: 'rolling',
      windowHours: 12,
      roles: ['user', 'auditor'],
    });
    const update = await lastEntry('quota.policy.update');
    expect(update).toMatchObject({ limitValue: 250, windowKind: 'rolling', windowHours: 12 });
    expect(update.changes).toEqual(
      expect.arrayContaining([
        { key: 'limitValue', before: 100, after: 250 },
        { key: 'windowKind', before: 'daily', after: 'rolling' },
        { key: 'windowHours', before: null, after: 12 },
        { key: 'roles', before: ['user'], after: ['auditor', 'user'] },
      ]),
    );
    expect(update.changes).toHaveLength(4);

    const person = await seedUser(live.db, state.organizationId, { role: 'user' });
    await send('PUT', `/users/${person}/quota-overrides`, { policyId: id, limitValue: 300 });
    expect((await lastEntry('quota.override.set')).previous).toBeNull();
    await send('PUT', `/users/${person}/quota-overrides`, {
      policyId: id,
      limitValue: 500,
      reason: 'Exam week',
    });
    expect(await lastEntry('quota.override.set')).toMatchObject({
      limitValue: 500,
      previous: { limitValue: 300, expiresAt: null, reason: null },
    });
    await send('DELETE', `/users/${person}/quota-overrides/${id}`);
    expect((await lastEntry('quota.override.clear')).previous).toEqual({
      limitValue: 500,
      expiresAt: null,
      reason: 'Exam week',
    });
  });

  it("records each account's previous role in a bulk role change", async () => {
    const restricted = await seedUser(live.db, state.organizationId, { role: 'restricted' });
    const user = await seedUser(live.db, state.organizationId, { role: 'user' });
    const result = await applyBulkUserAction(
      { id: admin, email: ADMIN_EMAIL },
      { userIds: [admin, restricted, user], action: 'set_role', role: 'auditor' },
      null,
    );
    expect(result).toMatchObject({ affected: 2, skippedSelf: true });
    expect(await lastEntry('user.bulk.set_role')).toMatchObject({
      role: 'auditor',
      affected: 2,
      previousRoles: { [restricted]: 'restricted', [user]: 'user' },
    });
    const roles = await live.db
      .select({ role: schema.user.role })
      .from(schema.user)
      .where(and(eq(schema.user.organizationId, state.organizationId), eq(schema.user.id, user)));
    expect(roles).toEqual([{ role: 'auditor' }]);
  });

  it('records the expected end of read-only mode as saved, and what it was before', async () => {
    const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await send('PUT', '/maintenance', { readOnly: true, reason: 'Walk3 check', until });
    expect(await lastEntry('maintenance.read_only.update')).toMatchObject({
      until,
      previous: { readOnly: false, reason: null, until: null },
    });
    await send('PUT', '/maintenance', { readOnly: false });
    expect(await lastEntry('maintenance.read_only.update')).toMatchObject({
      until: null,
      previous: { readOnly: true, reason: 'Walk3 check', until },
    });
  });
});
