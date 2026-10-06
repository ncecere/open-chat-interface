import { asc, eq, schema } from '@oci/db';
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
 * Unbanning an account leaves no ban reason behind, by every path (#350):
 * `PATCH /api/admin/users/:id` with only `{"banned": false}` left the old
 * reason stored, and the entry's `before` did not name it. The Users page
 * sends `banReason: null` itself and the bulk unban clears it; the stored
 * state is the same whichever way an account is unbanned. Through the real
 * routes, bulk service and PostgreSQL.
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
const { applyBulkUserAction } = await import('../../services/admin-users/bulk-actions.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: unbanning clears the ban reason (#350)', () => {
  let live: LiveDatabase;
  let admin: { id: string; email: string };
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin.id,
      role: 'admin',
      name: 'Admin',
      email: admin.email,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/users', userRoutes);

  async function patch(id: string, body: unknown) {
    const response = await app.request(`/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
  }

  const stored = async (id: string) => {
    const [row] = await live.db
      .select({ banned: schema.user.banned, banReason: schema.user.banReason })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    return row;
  };

  const updates = async (id: string) =>
    (
      await live.db
        .select({ metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, id))
        .orderBy(asc(schema.auditLog.seq))
    )
      .map((entry) => entry.metadata)
      .filter((metadata) => metadata && 'banned' in metadata);

  async function seed(email: string) {
    return seedUser(live.db, state.organizationId, { email });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_unban_reason');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = {
      id: await seedUser(live.db, state.organizationId, {
        role: 'admin',
        email: 'unban-admin@example.test',
      }),
      email: 'unban-admin@example.test',
    };
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('clears the reason when only {"banned": false} is sent, and records the reason it lifted', async () => {
    const id = await seed('unban-api@example.test');
    await patch(id, { banned: true, banReason: 'Walk8 ban check' });
    expect(await stored(id)).toEqual({ banned: true, banReason: 'Walk8 ban check' });

    await patch(id, { banned: false });
    expect(await stored(id)).toEqual({ banned: false, banReason: null });
    expect(await updates(id)).toEqual([
      {
        email: 'unban-api@example.test',
        banned: true,
        banReason: 'Walk8 ban check',
        before: { banned: false, banReason: null },
      },
      {
        email: 'unban-api@example.test',
        banned: false,
        banReason: null,
        before: { banned: true, banReason: 'Walk8 ban check' },
      },
    ]);
  });

  it('clears it too when an unban is sent with a reason, and keeps the reason of a ban that stays', async () => {
    const id = await seed('unban-with-reason@example.test');
    await patch(id, { banned: true, banReason: 'First' });
    // Editing the reason of an account that stays banned.
    await patch(id, { banReason: 'Second' });
    expect(await stored(id)).toEqual({ banned: true, banReason: 'Second' });
    // An unban that names a reason: nothing to keep.
    await patch(id, { banned: false, banReason: 'Not a ban any more' });
    expect(await stored(id)).toEqual({ banned: false, banReason: null });
  });

  it('is the same as the Users page and a bulk unban', async () => {
    const viaPage = await seed('unban-page@example.test');
    await patch(viaPage, { banned: true, banReason: 'Page' });
    await patch(viaPage, { banned: false, banReason: null });

    const viaBulk = await seed('unban-bulk@example.test');
    await applyBulkUserAction(admin, { userIds: [viaBulk], action: 'ban', reason: 'Bulk' }, null);
    await applyBulkUserAction(admin, { userIds: [viaBulk], action: 'unban' }, null);

    expect(await stored(viaPage)).toEqual({ banned: false, banReason: null });
    expect(await stored(viaBulk)).toEqual({ banned: false, banReason: null });
  });

  it('stores no reason on an account that is not banned', async () => {
    const id = await seed('unban-stale@example.test');
    // As an earlier release's API-only unban left it.
    await live.db
      .update(schema.user)
      .set({ banned: false, banReason: 'Stale' })
      .where(eq(schema.user.id, id));
    // A reason sent to an account that is not banned is not stored either.
    await patch(id, { banReason: 'Without a ban' });
    expect(await stored(id)).toEqual({ banned: false, banReason: null });
  });
});
