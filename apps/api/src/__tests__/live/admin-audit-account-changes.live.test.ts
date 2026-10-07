import { asc, eq, schema, sql } from '@oci/db';
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
 * Role changes, bans and unbans name the account by its email as well as its
 * ID, and a ban or unban records what it replaced (#323): the Target column
 * showed only "user: 4f331194-…", an unban did not say which reason it lifted,
 * and once the account was deleted its email no longer found these entries.
 * Through the real user and audit routes and PostgreSQL.
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
// These routes never call Better Auth; the import only needs to resolve.
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));

const { userRoutes } = await import('../../routes/admin/users.js');
const { auditRoutes } = await import('../../routes/admin/audit.js');
const { applyBulkUserAction } = await import('../../services/admin-users/bulk-actions.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const ADMIN_EMAIL = 'account-changes-admin@example.test';
const TARGET_EMAIL = 'walk7-target@example.test';

describe.skipIf(!available)('live: account changes name the account (#323)', () => {
  let live: LiveDatabase;
  let admin: string;
  let target: string;
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
  app.route('/users', userRoutes);
  app.route('/audit', auditRoutes);

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  }

  const entriesFor = async (userId: string) =>
    (
      await live.db
        .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, userId))
        .orderBy(asc(schema.auditLog.seq))
    ).filter((entry) => entry.action !== 'user.create');

  beforeAll(async () => {
    live = await createLiveDatabase('audit_account_changes');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, state.organizationId, { role: 'admin', email: ADMIN_EMAIL });
    target = await seedUser(live.db, state.organizationId, { email: TARGET_EMAIL });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('records the email, and what a ban or unban replaced', async () => {
    await send('PATCH', `/users/${target}`, { role: 'admin' });
    await send('PATCH', `/users/${target}`, { banned: true, banReason: 'Walk7 ban check' });
    await send('PATCH', `/users/${target}`, { banned: false, banReason: null });
    await send('PATCH', `/users/${target}`, { role: 'user' });
    await send('POST', `/users/${target}/revoke-sessions`, {});

    expect(await entriesFor(target)).toEqual([
      {
        action: 'user.role.change',
        metadata: { email: TARGET_EMAIL, from: 'user', to: 'admin' },
      },
      {
        action: 'user.ban',
        metadata: {
          email: TARGET_EMAIL,
          banned: true,
          banReason: 'Walk7 ban check',
          before: { banned: false, banReason: null },
        },
      },
      {
        action: 'user.unban',
        metadata: {
          email: TARGET_EMAIL,
          banned: false,
          banReason: null,
          before: { banned: true, banReason: 'Walk7 ban check' },
        },
      },
      {
        action: 'user.role.change',
        metadata: { email: TARGET_EMAIL, from: 'admin', to: 'user' },
      },
      {
        action: 'user.revoke_sessions',
        metadata: { email: TARGET_EMAIL, sessionsEnded: 0 },
      },
    ]);
  });

  it('records a bulk ban and unban with each account, its email and its ban before', async () => {
    const other = await seedUser(live.db, state.organizationId, {
      email: 'walk7-bulk@example.test',
    });
    const actor = { id: admin, email: ADMIN_EMAIL };
    await applyBulkUserAction(actor, { userIds: [other], action: 'ban', reason: 'Bulk' }, null);
    await applyBulkUserAction(actor, { userIds: [other], action: 'unban' }, null);
    const rows = await live.db
      .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} in ('user.bulk.ban', 'user.bulk.unban')`)
      .orderBy(asc(schema.auditLog.seq));
    expect(rows.map((row) => [row.action, row.metadata])).toEqual([
      [
        'user.bulk.ban',
        expect.objectContaining({
          emails: ['walk7-bulk@example.test'],
          previousBans: { [other]: { banned: false, banReason: null } },
        }),
      ],
      [
        'user.bulk.unban',
        expect.objectContaining({
          emails: ['walk7-bulk@example.test'],
          previousBans: { [other]: { banned: true, banReason: 'Bulk' } },
        }),
      ],
    ]);
  });

  it('still finds them by the email once the account is deleted', async () => {
    await live.db.execute(sql`delete from "user" where id = ${target}`);
    const { entries } = (await send('GET', '/audit?search=walk7-target')) as {
      entries: { action: string }[];
    };
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.ban',
      'user.revoke_sessions',
      'user.role.change',
      'user.role.change',
      'user.unban',
    ]);
  });

  it('records a ban and an unban under their own actions, and other edits as user.update (#375)', async () => {
    const person = await seedUser(live.db, state.organizationId, {
      email: 'walk9-ban@example.test',
    });
    // A rename with the ban: two entries, the ban without the name.
    await send('PATCH', `/users/${person}`, { banned: true, banReason: 'Walk9', name: 'Renamed' });
    // Editing the reason of an account that stays banned is neither.
    await send('PATCH', `/users/${person}`, { banReason: 'Walk9 reworded' });
    await send('PATCH', `/users/${person}`, { banned: false });
    // Sending the state it already has is not a ban or an unban either.
    await send('PATCH', `/users/${person}`, { banned: false });
    const entries = await entriesFor(person);
    expect(entries.map((entry) => entry.action)).toEqual([
      'user.update',
      'user.ban',
      'user.update',
      'user.unban',
      'user.update',
    ]);
    expect(entries[1]?.metadata).toEqual({
      email: 'walk9-ban@example.test',
      banned: true,
      banReason: 'Walk9',
      before: { banned: false, banReason: null },
    });
    expect(entries[0]?.metadata).toMatchObject({ name: 'Renamed' });
    expect(entries[0]?.metadata).not.toHaveProperty('banned');
    expect(entries[2]?.metadata).toMatchObject({ banReason: 'Walk9 reworded' });
    expect(entries[3]?.metadata).toMatchObject({
      banned: false,
      banReason: null,
      before: { banned: true, banReason: 'Walk9 reworded' },
    });
  });
});
