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

const { providerRoutes } = await import('../../routes/admin/providers.js');
const { modelRoutes } = await import('../../routes/admin/models.js');
const { reportRoutes } = await import('../../routes/admin/reports.js');
const { broadcastRoutes } = await import('../../routes/admin/broadcasts.js');
const { inviteRoutes } = await import('../../routes/admin/invites.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

/**
 * A deleted row no longer resolves, so its audit entry has to say what it was
 * ("which provider, report or announcement was removed?").
 */
describe.skipIf(!available)('live: delete and revoke audit entries say what was removed', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let organizationId: string;

  async function remove(path: string) {
    const response = await app.request(path, { method: 'DELETE' });
    return response.status;
  }
  async function entry(action: string, targetId: string) {
    const [row] = await live.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)));
    return row?.metadata;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_delete_audit');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    const actor = await seedUser(live.db, organizationId, { role: 'admin' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Audit admin',
        email: 'audit-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId,
      });
      await next();
    });
    app.route('/providers', providerRoutes);
    app.route('/models', modelRoutes);
    app.route('/reports', reportRoutes);
    app.route('/broadcasts', broadcastRoutes);
    app.route('/invites', inviteRoutes);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('records the provider and the model that were deleted', async () => {
    const [provider] = await live.db
      .insert(schema.provider)
      .values({
        organizationId,
        kind: 'openai-compatible',
        label: 'Walk gateway',
        baseUrl: 'https://gw.example.test/v1',
      })
      .returning();
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId,
        providerId: provider!.id,
        slug: 'walk-model',
        upstreamModelId: 'walk-upstream',
        displayName: 'Walk model',
      })
      .returning();

    expect(await remove(`/models/${model!.id}`)).toBe(200);
    expect(await entry('model.delete', model!.id)).toMatchObject({
      slug: 'walk-model',
      displayName: 'Walk model',
      upstreamModelId: 'walk-upstream',
    });

    expect(await remove(`/providers/${provider!.id}`)).toBe(200);
    const recorded = await entry('provider.delete', provider!.id);
    expect(recorded).toMatchObject({ label: 'Walk gateway', kind: 'openai-compatible' });
    expect(JSON.stringify(recorded)).not.toMatch(/key/i);
  });

  it('answers 404 for a model that does not exist, and records nothing', async () => {
    expect(await remove('/models/not-a-model')).toBe(404);
    expect(await entry('model.delete', 'not-a-model')).toBeUndefined();
  });

  it('records the report, announcement and invitation that were removed', async () => {
    const [report] = await live.db
      .insert(schema.scheduledReport)
      .values({
        organizationId,
        name: 'Walk daily usage',
        cadence: 'daily',
        recipients: ['ops@example.test'],
      })
      .returning();
    expect(await remove(`/reports/${report!.id}`)).toBe(200);
    expect(await entry('report.delete', report!.id)).toMatchObject({
      name: 'Walk daily usage',
      cadence: 'daily',
    });

    const [announcement] = await live.db
      .insert(schema.broadcast)
      .values({ organizationId, title: 'Walk maintenance', body: 'Down on **Sunday**.' })
      .returning();
    expect(await remove(`/broadcasts/${announcement!.id}`)).toBe(200);
    expect(await entry('broadcast.delete', announcement!.id)).toMatchObject({
      title: 'Walk maintenance',
      body: 'Down on **Sunday**.',
    });

    const [invite] = await live.db
      .insert(schema.invitation)
      .values({
        organizationId,
        email: 'walk.invitee@example.test',
        role: 'admin',
        tokenHash: 'hash',
      })
      .returning();
    expect(await remove(`/invites/${invite!.id}`)).toBe(200);
    expect(await entry('invite.revoke', invite!.id)).toMatchObject({
      email: 'walk.invitee@example.test',
      role: 'admin',
    });
  });
});
