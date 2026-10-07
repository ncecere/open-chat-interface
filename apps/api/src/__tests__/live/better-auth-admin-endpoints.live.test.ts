import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Every account change an administrator makes goes through OCI's own routes
 * (/api/admin/users/...), which audit it with before and after, send
 * webhooks, refuse self-demotion and removing the last administrator, and
 * respect legal holds. Better Auth's admin plugin also answers
 * /api/auth/admin/* for any administrator's session, doing the same changes
 * (and impersonation) with none of that: QA walk 5 changed roles, banned,
 * changed an email and marked it verified, reset a password and impersonated
 * a person with no audit entry at all. The web app never calls them, so the
 * API refuses the whole path. Real Better Auth and PostgreSQL, through the
 * real /api routes, with a signed-in administrator.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE: 1000,
    }),
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    if (key === 'auth')
      return {
        registrationMode: 'open',
        localAuthEnabled: true,
        emailVerificationRequired: false,
        sessionLifetimeDays: 30,
        sessionRefreshDays: 1,
      };
    if (key === 'smtp') return { host: null, port: 25, fromAddress: null };
    return {};
  },
}));

const available = await livePostgresAvailable();
const PASSWORD = 'admin-endpoints-password-1234';

describe.skipIf(!available)('live: Better Auth admin endpoints', { timeout: 30_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('better_auth_admin');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api', createApiRoutes());
  });

  afterAll(async () => {
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function account(role: string) {
    const { auth } = await import('../../auth/index.js');
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: role } });
    await pool.db.execute(sql`update "user" set role = ${role} where id = ${created.user.id}`);
    return { id: created.user.id, email };
  }

  async function signIn(email: string) {
    const response = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  }

  it('refuses every admin endpoint to an administrator, and changes nothing', async () => {
    const admin = await account('admin');
    const target = await account('user');
    const cookie = await signIn(admin.email);
    const call = (method: string, path: string, body?: Record<string, unknown>) =>
      app.request(`/api/auth/admin/${path}`, {
        method,
        headers: { cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const attempts: Array<[string, string, Record<string, unknown>?]> = [
      ['POST', 'set-role', { userId: target.id, role: 'admin' }],
      ['POST', 'set-role', { userId: admin.id, role: 'user' }],
      ['POST', 'ban-user', { userId: target.id }],
      ['POST', 'unban-user', { userId: target.id }],
      ['POST', 'update-user', { userId: target.id, data: { email: 'moved@example.test' } }],
      ['POST', 'set-user-password', { userId: target.id, newPassword: 'another-password-1234' }],
      ['POST', 'impersonate-user', { userId: target.id }],
      ['POST', 'stop-impersonating', {}],
      ['POST', 'revoke-user-sessions', { userId: target.id }],
      ['POST', 'create-user', { email: 'made@example.test', password: PASSWORD, name: 'Made' }],
      ['POST', 'remove-user', { userId: target.id }],
      ['GET', 'list-users'],
      ['GET', `get-user?id=${target.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({ message: expect.stringMatching(/People/) });
    }

    const [after] = await pool.db.select().from(schema.user).where(eq(schema.user.id, target.id));
    expect(after).toMatchObject({ role: 'user', banned: false, email: target.email });
    const [self] = await pool.db.select().from(schema.user).where(eq(schema.user.id, admin.id));
    expect(self?.role).toBe('admin');
    const made = await pool.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'made@example.test'));
    expect(made).toEqual([]);
    const impersonations = await pool.db.execute(
      sql`select count(*)::int as n from "session" where impersonated_by is not null`,
    );
    expect((impersonations as unknown as Array<{ n: number }>)[0]?.n ?? 0).toBe(0);
    // The target can still sign in with their own password.
    await signIn(target.email);
  });
});
