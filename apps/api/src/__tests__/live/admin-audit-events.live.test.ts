import { randomUUID } from 'node:crypto';
import { eq, schema } from '@oci/db';
import { PROTECTED_AUDIT_ACTIONS } from '@oci/shared';
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
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getRetentionSettings: async () => ({
    trashRetentionDays: 30,
    threadRetentionDays: null,
    exemptPinnedThreads: true,
    usageEventRetentionDays: 90,
    auditLogRetentionDays: 1,
    displayTimezone: 'UTC',
  }),
}));
// These routes never call Better Auth; the import only needs to resolve.
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));

const { userRoutes } = await import('../../routes/admin/users.js');
const { ssoRoutes } = await import('../../routes/admin/sso.js');
const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { pruneAuditLog } = await import('../../services/lifecycle/retention.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function adminApp(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Audit admin',
      email: 'audit-admin@example.test',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/users', userRoutes);
  app.route('/sso', ssoRoutes);
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
}

describe.skipIf(!available)('live: protected administrative audit events', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  async function events(action: string) {
    return live.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    app = adminApp(await seedUser(live.db, state.organizationId, { role: 'admin' }));
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('records a role change under its protected action, but not an unchanged role', async () => {
    const target = await seedUser(live.db, state.organizationId, { role: 'user' });
    await send(app, 'PATCH', `/users/${target}`, { role: 'auditor' });
    await send(app, 'PATCH', `/users/${target}`, { role: 'auditor', name: 'Renamed' });

    const changes = await events('user.role.change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      targetId: target,
      metadata: { from: 'user', to: 'auditor' },
    });
  });

  it('records sign-in policy changes separately from other settings', async () => {
    await send(app, 'PATCH', '/settings', { colorTheme: 'violet' });
    expect(await events('settings.auth.update')).toHaveLength(0);

    await send(app, 'PATCH', '/settings', { sessionLifetimeDays: 10, colorTheme: 'blue' });
    const [event] = await events('settings.auth.update');
    expect(event?.metadata).toMatchObject({
      keys: ['sessionLifetimeDays'],
      changes: [expect.objectContaining({ key: 'sessionLifetimeDays', after: 10 })],
    });
  });

  it('lets an SSO provider be edited to every role creation accepts', async () => {
    const providerId = `oidc-${randomUUID().slice(0, 8)}`;
    await live.db.insert(schema.ssoProvider).values({
      id: randomUUID(),
      providerId,
      issuer: 'https://idp.example.test',
      domain: 'example.test',
      organizationId: state.organizationId,
    });
    await send(app, 'PATCH', `/sso/providers/${providerId}`, {
      defaultRole: 'auditor',
      claimRoleMappings: [{ claim: 'groups', value: 'reviewers', role: 'auditor' }],
    });
    const [stored] = await live.db
      .select()
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.providerId, providerId));
    expect(stored).toMatchObject({
      defaultRole: 'auditor',
      claimRoleMappings: [{ claim: 'groups', value: 'reviewers', role: 'auditor' }],
    });
  });

  it('keeps protected access-control events through audit retention', async () => {
    const actorUserId = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const old = new Date(Date.now() - 10 * 86_400_000);
    await live.db.insert(schema.auditLog).values(
      ['user.role.change', 'user.bulk.set_role', 'settings.auth.update', 'settings.update'].map(
        (action) => ({
          organizationId: state.organizationId,
          actorUserId,
          action,
          targetType: 'instance',
          createdAt: old,
        }),
      ),
    );
    await pruneAuditLog();
    const remaining = await live.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actorUserId, actorUserId));
    expect(remaining.map((row) => row.action).sort()).toEqual([
      'settings.auth.update',
      'user.bulk.set_role',
      'user.role.change',
    ]);
    expect(PROTECTED_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['user.role.change', 'user.bulk.set_role', 'settings.auth.update']),
    );
  });
});
