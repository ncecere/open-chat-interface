import { and, createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

function appFor(actorId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role: 'admin',
      name: 'Fix6 admin',
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

type Body = { error?: { message: string } };

async function send(actor: string, method: string, path: string, body: unknown) {
  const response = await appFor(actor).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

const demote = (actor: string, target: string) =>
  send(actor, 'PATCH', `/users/${target}`, { role: 'user' });
const ban = (actor: string, target: string) =>
  send(actor, 'PATCH', `/users/${target}`, { banned: true, banReason: 'Fix6' });
const bulk = (actor: string, target: string, action: 'set_role' | 'ban') =>
  send(actor, 'POST', '/users/bulk', {
    userIds: [target],
    action,
    ...(action === 'set_role' ? { role: 'auditor' } : {}),
  });
const remove = (actor: string, target: string) =>
  send(actor, 'DELETE', `/users/${target}`, undefined);

/**
 * Role changes and bans, single and in bulk, take the administrators' lock
 * that deletion takes and refuse to leave no administrator who can sign in
 * (#304). Two administrators acting on each other at the same moment, over
 * separate connections of a real PostgreSQL: one change wins, the other is
 * refused, and an administrator remains. Before, both committed.
 */
describe.skipIf(!available)('live: the last administrator, raced', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_last_admin_race');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });
  beforeEach(async () => {
    await live.db.update(schema.user).set({ role: 'user' }).where(eq(schema.user.role, 'admin'));
  });
  afterAll(async () => {
    await live?.destroy();
  });

  /** Administrators who can still sign in. */
  async function workingAdmins() {
    const rows = await live.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(and(eq(schema.user.role, 'admin'), eq(schema.user.banned, false)));
    return rows.map((row) => row.id);
  }

  /** Runs both requests at once, each on its own connection. */
  async function atOnce<T>(requests: () => Promise<T>[]): Promise<T[]> {
    const { db: pooled, sql: client } = createDatabase(live.connectionString, { max: 4 });
    state.db = pooled;
    try {
      return await Promise.all(requests());
    } finally {
      state.db = live.db;
      await client.end({ timeout: 5 });
    }
  }

  async function twoAdmins() {
    return [
      await seedUser(live.db, state.organizationId, { role: 'admin' }),
      await seedUser(live.db, state.organizationId, { role: 'admin' }),
    ] as const;
  }

  it.each([
    ['demoting each other', demote, demote, /their role cannot be changed/],
    ['banning each other', ban, ban, /cannot be banned/],
    ['one demoting, the other banning', demote, ban, /last administrator/],
  ] as const)('%s at once leaves an administrator', async (_name, first, second, refusal) => {
    const [a, b] = await twoAdmins();
    const results = await atOnce(() => [first(a, b), second(b, a)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.error?.message).toMatch(refusal);
    expect(await workingAdmins()).toHaveLength(1);
  });

  it.each([
    ['set_role', 'set_role'],
    ['ban', 'ban'],
    ['set_role', 'ban'],
  ] as const)('bulk %s and %s on each other at once leave an administrator', async (x, y) => {
    const [a, b] = await twoAdmins();
    const results = await atOnce(() => [bulk(a, b, x), bulk(b, a, y)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.error?.message).toMatch(
      /leave no administrator/,
    );
    expect(await workingAdmins()).toHaveLength(1);
  });

  it('a ban and a deletion at once leave an administrator who can sign in', async () => {
    const [a, b] = await twoAdmins();
    const results = await atOnce(() => [ban(a, b), remove(b, a)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await workingAdmins()).toHaveLength(1);
  });

  it('still lets an administrator demote or ban another when one remains', async () => {
    const [a, b] = await twoAdmins();
    expect((await demote(a, b)).status).toBe(200);
    const c = await seedUser(live.db, state.organizationId, { role: 'admin' });
    expect((await bulk(a, c, 'ban')).status).toBe(200);
    expect(await workingAdmins()).toEqual([a]);
    // A banned administrator can be demoted: it takes nobody away who can sign in.
    expect((await demote(a, c)).status).toBe(200);
  });
});
