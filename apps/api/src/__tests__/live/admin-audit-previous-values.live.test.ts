import { randomUUID } from 'node:crypto';
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
 * The edits #221 left out record what each value was as well as what it
 * became (#258): retention, rate limits, an SSO provider, an announcement, a
 * connector, a webhook and a scheduled report, through the real routes and
 * the database.
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

const { lifecycleRoutes } = await import('../../routes/admin/lifecycle.js');
const { ssoRoutes } = await import('../../routes/admin/sso.js');
const { broadcastRoutes } = await import('../../routes/admin/broadcasts.js');
const { connectorRoutes } = await import('../../routes/admin/connectors.js');
const { webhookRoutes } = await import('../../routes/admin/webhooks.js');
const { reportRoutes } = await import('../../routes/admin/reports.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

type Change = { key: string; before: unknown; after: unknown };

describe.skipIf(!available)('live: more audit entries record the previous value (#258)', () => {
  let live: LiveDatabase;
  let admin: string;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin,
      role: 'admin',
      name: 'Admin',
      email: 'previous-values@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/lifecycle', lifecycleRoutes);
  app.route('/sso', ssoRoutes);
  app.route('/broadcasts', broadcastRoutes);
  app.route('/connectors', connectorRoutes);
  app.route('/webhooks', webhookRoutes);
  app.route('/reports', reportRoutes);

  async function send(method: string, path: string, body: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  }

  async function changes(action: string): Promise<Change[]> {
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return ((entry?.metadata ?? {}) as { changes?: Change[] }).changes ?? [];
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit_previous');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    invalidateSettingsCache();
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('retention: the trash period as it was and became', async () => {
    await send('PUT', '/lifecycle/retention', { trashRetentionDays: 31 });
    await send('PUT', '/lifecycle/retention', { trashRetentionDays: 30 });
    expect(await changes('retention.settings.update')).toEqual([
      { key: 'trashRetentionDays', before: 31, after: 30 },
    ]);
  });

  it('rate limits: one role’s limit and the sign-in attempts, from what was in effect', async () => {
    await send('PUT', '/lifecycle/rate-limits', { authAttemptsPerMinute: 10 });
    await send('PUT', '/lifecycle/rate-limits', {
      authAttemptsPerMinute: 1000,
      roles: { user: { chatRequestsPerMinute: 7 } },
    });
    const recorded = await changes('rate_limit.settings.update');
    expect(recorded).toContainEqual({ key: 'authAttemptsPerMinute', before: 10, after: 1000 });
    expect(recorded).toContainEqual({
      key: 'roles.user.chatRequestsPerMinute',
      before: expect.any(Number),
      after: 7,
    });
    // Only what changed: not every other role's limits.
    expect(recorded).toHaveLength(2);
  });

  it('SSO: whether the provider was trusted for account linking', async () => {
    await live.db.insert(schema.ssoProvider).values({
      id: randomUUID(),
      providerId: 'previous-idp',
      issuer: 'https://idp.example.test/previous',
      domain: 'example.test',
      organizationId: state.organizationId,
      trustedForLinking: true,
    });
    await send('PATCH', '/sso/providers/previous-idp', { trustedForLinking: false });
    expect(await changes('sso.update')).toEqual([
      { key: 'trustedForLinking', before: true, after: false },
    ]);
  });

  it('announcement: the window and audience as they were', async () => {
    const [broadcast] = await live.db
      .insert(schema.broadcast)
      .values({
        organizationId: state.organizationId,
        title: 'Walk4 announcement',
        body: 'Body',
        level: 'info',
        audienceRoles: ['user'],
        published: true,
        startsAt: new Date('2026-10-06T10:00:00.000Z'),
        endsAt: null,
      })
      .returning();
    await send('PUT', `/broadcasts/${broadcast!.id}`, {
      title: 'Walk4 announcement',
      body: 'Body',
      level: 'info',
      audienceRoles: ['user', 'admin'],
      dismissable: broadcast!.dismissable,
      published: true,
      startsAt: '2026-10-06T10:00:00.000Z',
      endsAt: '2026-10-07T10:00:00.000Z',
    });
    expect(await changes('broadcast.update')).toEqual([
      { key: 'audienceRoles', before: ['user'], after: ['user', 'admin'] },
      { key: 'endsAt', before: null, after: '2026-10-07T10:00:00.000Z' },
    ]);
  });

  it('connector: the old and new server address', async () => {
    const [connector] = await live.db
      .insert(schema.connector)
      .values({
        organizationId: state.organizationId,
        name: 'Docs',
        slug: 'docs',
        url: 'https://mcp-old.example.com/mcp',
      })
      .returning();
    await send('PATCH', `/connectors/${connector!.id}`, { url: 'https://mcp-new.example.com/mcp' });
    expect(await changes('connector.update')).toEqual([
      {
        key: 'url',
        before: 'https://mcp-old.example.com/mcp',
        after: 'https://mcp-new.example.com/mcp',
      },
    ]);
  });

  it('webhook: the action filter it used to forward', async () => {
    const [endpoint] = await live.db
      .insert(schema.webhookEndpoint)
      .values({
        organizationId: state.organizationId,
        url: 'https://siem.example.com/hook',
        actions: ['invite.*'],
        encryptedSecret: 'not-used',
      })
      .returning();
    await send('PATCH', `/webhooks/${endpoint!.id}`, {
      actions: ['invite.*', 'user.role.change'],
    });
    expect(await changes('webhook.update')).toEqual([
      { key: 'actions', before: ['invite.*'], after: ['invite.*', 'user.role.change'] },
    ]);
  });

  it('report: the window as it was', async () => {
    const [report] = await live.db
      .insert(schema.scheduledReport)
      .values({
        organizationId: state.organizationId,
        name: 'Walk4 report',
        cadence: 'weekly',
        windowDays: 7,
        recipients: ['ops@example.test'],
      })
      .returning();
    await send('PATCH', `/reports/${report!.id}`, { windowDays: 14 });
    const recorded = await changes('report.update');
    expect(recorded).toContainEqual({ key: 'windowDays', before: 7, after: 14 });
    // Nothing reported as changed that was not.
    expect(recorded.filter((change) => change.key !== 'windowDays')).toEqual([]);
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'report.update'), eq(schema.auditLog.targetId, report!.id)),
      );
    expect(entry?.metadata).toMatchObject({ windowDays: 14 });
  });
});
