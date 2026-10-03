import { createDatabase, eq, schema, sql } from '@oci/db';
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

const { userRoutes } = await import('../../routes/admin/users.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

function appFor(actorId: string, role: 'admin' | 'auditor' = 'admin') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Deleting admin',
      email: `${actorId}@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/users', userRoutes);
  return app;
}

async function remove(app: Hono<AppBindings>, id: string) {
  const response = await app.request(`/users/${id}`, { method: 'DELETE' });
  const body = (await response.json()) as { ok?: boolean; error?: { message: string } };
  return { status: response.status, body };
}

/**
 * Deleting an account from the dashboard. The service refused self-deletion and
 * held accounts; these cases cover what it did not: a missing account, the last
 * administrator, and two administrators deleting each other at once.
 */
describe.skipIf(!available)('live: deleting an account', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_user_delete');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  async function exists(id: string) {
    const rows = await live.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    return rows.length === 1;
  }

  async function adminIds() {
    const rows = await live.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.role, 'admin'));
    return rows.map((row) => row.id);
  }

  async function demoteAllAdmins() {
    await live.db.update(schema.user).set({ role: 'user' }).where(eq(schema.user.role, 'admin'));
  }

  it('deletes the account and its data, keeps audit entries, and names the account in its own entry', async () => {
    const admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const target = await seedUser(live.db, state.organizationId, {
      email: 'leaving@example.test',
    });
    const [thread] = await live.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: target, title: 'Leaving' })
      .returning({ id: schema.thread.id });
    await live.db.insert(schema.auditLog).values({
      organizationId: state.organizationId,
      actorUserId: target,
      actorEmail: 'leaving@example.test',
      action: 'thread.export',
    });

    const result = await remove(appFor(admin), target);
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(await exists(target)).toBe(false);
    const threads = await live.db
      .select({ id: schema.thread.id })
      .from(schema.thread)
      .where(eq(schema.thread.id, thread!.id));
    expect(threads).toHaveLength(0);

    // Their own past actions stay, with the email that identified them.
    const [kept] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'thread.export'));
    expect(kept).toMatchObject({ actorUserId: null, actorEmail: 'leaving@example.test' });

    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.delete'));
    expect(entry).toMatchObject({ actorUserId: admin, targetType: 'user', targetId: target });
    expect(entry!.metadata).toMatchObject({ email: 'leaving@example.test', role: 'user' });
  });

  it('answers 404 for an account that does not exist and records nothing', async () => {
    const admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const before = await live.db.execute(sql`select count(*)::int as n from audit_log`);

    const result = await remove(appFor(admin), 'no-such-account');
    expect(result.status).toBe(404);

    const after = await live.db.execute(sql`select count(*)::int as n from audit_log`);
    expect(after[0]).toEqual(before[0]);
  });

  it('refuses to delete your own account', async () => {
    const admin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const result = await remove(appFor(admin), admin);
    expect(result.status).toBe(422);
    expect(result.body.error?.message).toMatch(/your own account/);
    expect(await exists(admin)).toBe(true);
  });

  it('never lets an auditor delete an account', async () => {
    const auditor = await seedUser(live.db, state.organizationId, { role: 'auditor' });
    const target = await seedUser(live.db, state.organizationId);
    const result = await remove(appFor(auditor, 'auditor'), target);
    expect(result.status).toBe(403);
    expect(await exists(target)).toBe(true);
  });

  it('refuses to delete the last administrator', async () => {
    await demoteAllAdmins();
    const onlyAdmin = await seedUser(live.db, state.organizationId, { role: 'admin' });
    // A session whose account lost the role after it was issued: the request
    // passes the route guard, but the account it would delete is the only
    // administrator left.
    const formerAdmin = await seedUser(live.db, state.organizationId, { role: 'user' });

    const result = await remove(appFor(formerAdmin), onlyAdmin);
    expect(result.status).toBe(409);
    expect(result.body.error?.message).toMatch(/last administrator/);
    expect(await exists(onlyAdmin)).toBe(true);
  });

  it('leaves an administrator when two administrators delete each other at once', async () => {
    await demoteAllAdmins();
    const first = await seedUser(live.db, state.organizationId, { role: 'admin' });
    const second = await seedUser(live.db, state.organizationId, { role: 'admin' });

    // Separate connections, so the two requests really overlap.
    const { db: pooled, sql: client } = createDatabase(live.connectionString, { max: 4 });
    state.db = pooled;
    try {
      const results = await Promise.all([
        remove(appFor(first), second),
        remove(appFor(second), first),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    } finally {
      state.db = live.db;
      await client.end({ timeout: 5 });
    }
    expect(await adminIds()).toHaveLength(1);
  });
});
