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
  return response;
}

describe.skipIf(!available)('live: protected administrative audit events', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let actor: string;

  async function events(action: string) {
    return live.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app = adminApp(actor);
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

  it('writes one audit entry (one webhook event) for one role change (#140)', async () => {
    const target = await seedUser(live.db, state.organizationId, { role: 'user' });
    const forTarget = () =>
      live.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, target));

    await send(app, 'PATCH', `/users/${target}`, { role: 'restricted' });
    expect((await forTarget()).map(({ action, metadata }) => ({ action, metadata }))).toEqual([
      {
        action: 'user.role.change',
        metadata: { email: expect.any(String), from: 'user', to: 'restricted' },
      },
    ]);

    // A rename with the role change keeps the rename under user.update, without the role.
    await send(app, 'PATCH', `/users/${target}`, { role: 'user', name: 'Walk3 renamed' });
    const entries = (await forTarget()).map(({ action, metadata }) => ({ action, metadata }));
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          action: 'user.role.change',
          metadata: { email: expect.any(String), from: 'restricted', to: 'user' },
        },
        // With the name it replaced (#323).
        {
          action: 'user.update',
          metadata: {
            email: expect.any(String),
            name: 'Walk3 renamed',
            before: { name: 'Test User' },
          },
        },
      ]),
    );
  });

  it('ends active sessions when a single account is banned', async () => {
    const target = await seedUser(live.db, state.organizationId, { role: 'user' });
    await live.db.insert(schema.session).values({
      id: randomUUID(),
      userId: target,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await send(app, 'PATCH', `/users/${target}`, { banned: true, banReason: 'Test' });
    const sessions = await live.db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, target));
    expect(sessions).toHaveLength(0);
    const [stored] = await live.db.select().from(schema.user).where(eq(schema.user.id, target));
    expect(stored).toMatchObject({ banned: true, banReason: 'Test' });
  });

  it('reports accounts and sessions for a bulk sign-out, skipping yourself (#145)', async () => {
    const busy = await seedUser(live.db, state.organizationId, { role: 'user' });
    const idle = await seedUser(live.db, state.organizationId, { role: 'user' });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await live.db.insert(schema.session).values(
      [busy, busy, actor].map((userId) => ({
        id: randomUUID(),
        userId,
        token: randomUUID(),
        expiresAt,
      })),
    );
    const response = await send(app, 'POST', '/users/bulk', {
      action: 'revoke_sessions',
      userIds: [actor, busy, idle],
    });
    expect(await response.json()).toEqual({ affected: 2, skippedSelf: true, sessionsEnded: 2 });
    const [entry] = await events('user.bulk.revoke_sessions');
    expect(entry?.metadata).toMatchObject({ requested: 3, affected: 2, sessionsEnded: 2 });
    // Your own session is untouched.
    const own = await live.db.select().from(schema.session).where(eq(schema.session.userId, actor));
    expect(own).toHaveLength(1);
  });

  it('records how many sessions Sign out everywhere ended (#148)', async () => {
    const target = await seedUser(live.db, state.organizationId, { role: 'user' });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await live.db
      .insert(schema.session)
      .values(
        [1, 2].map(() => ({ id: randomUUID(), userId: target, token: randomUUID(), expiresAt })),
      );
    await send(app, 'POST', `/users/${target}/revoke-sessions`, {});
    const [entry] = (await events('user.revoke_sessions')).filter((row) => row.targetId === target);
    expect(entry?.metadata).toEqual({ email: expect.any(String), sessionsEnded: 2 });
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
