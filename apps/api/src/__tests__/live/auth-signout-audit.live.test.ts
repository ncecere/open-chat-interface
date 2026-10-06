import { randomUUID } from 'node:crypto';
import { createDatabase, sql } from '@oci/db';
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
 * Sign-outs in the audit log (#279). Every `auth.signout.success` was
 * recorded with no actor, shown as "System", and never appeared in the
 * person's trail or a search by their email: Better Auth's sign-out endpoint
 * reads the session cookie itself, so the after hook saw no session. Real
 * Better Auth and PostgreSQL, through the real /api routes.
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
const PASSWORD = 'signout-audit-password-1234';

describe.skipIf(!available)('live: sign-out audit', { timeout: 30_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('auth_signout_audit');
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

  const audits = (action: string) =>
    pool.db.execute<{ actor_user_id: string | null; actor_email: string | null }>(
      sql`select actor_user_id, actor_email from audit_log where action = ${action} order by seq`,
    );

  it('names the person who signed out, as a sign-in does', async () => {
    const { auth } = await import('../../auth/index.js');
    const email = `fix5-signout-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'S' } });
    const signedIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');

    const signedOut = await app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { cookie, origin },
    });
    expect(signedOut.status).toBe(200);
    const actor = { actor_user_id: created.user.id, actor_email: email };
    expect(await audits('auth.signin.local.success')).toEqual([actor]);
    expect(await audits('auth.signout.success')).toEqual([actor]);
    // The session is gone: signing out again names nobody, and records it as before.
    await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie, origin } });
    expect((await audits('auth.signout.success')).at(-1)).toEqual({
      actor_user_id: null,
      actor_email: null,
    });
  });
});
