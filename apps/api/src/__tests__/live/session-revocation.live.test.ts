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
 * A role change, a ban and a revoked session take effect on the very next
 * request, on every replica. Reproduced first: with Better Auth's session
 * cookie cache (five minutes) the signed `session_data` cookie answered
 * getSession without reading the database, so a demoted administrator kept
 * administering, and a banned or signed-out person kept using OCI, for up to
 * five minutes. The cache is off; every request reads the session and the
 * person from the database (measured below).
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  resetLinks: [] as string[],
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// The emailed link, as the person would open it (no mail server here).
vi.mock('../../services/email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email.js')>()),
  sendPasswordResetEmail: async ({ url }: { url: string }) => {
    state.resetLinks.push(url);
  },
}));
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
const PASSWORD = 'revocation-password-1234';

describe.skipIf(!available)('live: role changes, bans and revocations apply at once', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('session_revocation');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { auth } = await import('../../auth/index.js');
    const { requireAdmin, requireAuth, sessionMiddleware } = await import(
      '../../middleware/context.js'
    );
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
    app.use('/api/*', sessionMiddleware);
    app.get('/api/probe', requireAuth, (c) => c.json({ role: c.get('user')?.role }));
    app.get('/api/admin-probe', requireAdmin, (c) => c.json({ ok: true }));
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  /** A signed-in administrator: their id and the cookies a browser would send. */
  async function signedInAdmin() {
    const { auth } = await import('../../auth/index.js');
    const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Admin' },
    });
    await pool.db.execute(sql`update "user" set role = 'admin' where id = ${created.user.id}`);
    const response = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    return { id: created.user.id, cookie };
  }

  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });

  it('applies a role change on the next request', async () => {
    const admin = await signedInAdmin();
    expect((await get('/api/admin-probe', admin.cookie)).status).toBe(200);
    await pool.db.execute(sql`update "user" set role = 'user' where id = ${admin.id}`);
    expect((await get('/api/admin-probe', admin.cookie)).status).toBe(403);
    expect(await (await get('/api/probe', admin.cookie)).json()).toEqual({ role: 'user' });
  });

  it('ends a banned or revoked session on the next request', async () => {
    const banned = await signedInAdmin();
    expect((await get('/api/probe', banned.cookie)).status).toBe(200);
    // What People → Users does when banning: the flag, and the sessions ended.
    await pool.db.execute(sql`update "user" set banned = true where id = ${banned.id}`);
    await pool.db.execute(sql`delete from session where user_id = ${banned.id}`);
    expect((await get('/api/probe', banned.cookie)).status).toBe(401);

    const revoked = await signedInAdmin();
    expect((await get('/api/probe', revoked.cookie)).status).toBe(200);
    await pool.db.execute(sql`delete from session where user_id = ${revoked.id}`);
    expect((await get('/api/probe', revoked.cookie)).status).toBe(401);
  });

  it('ends every session when the password is reset from the emailed link (#139)', async () => {
    const { auth } = await import('../../auth/index.js');
    // A session someone else holds (a stolen laptop), and the owner's own.
    const stolen = await signedInAdmin();
    const [{ email }] = (await pool.db.execute<{ email: string }>(
      sql`select email from "user" where id = ${stolen.id}`,
    )) as unknown as [{ email: string }];
    expect((await get('/api/probe', stolen.cookie)).status).toBe(200);

    const requested = await app.request('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, redirectTo: '/auth/reset-password' }),
    });
    expect(requested.status).toBe(200);
    // Better Auth may send in the background.
    await vi.waitFor(() => expect(state.resetLinks).toHaveLength(1));
    // The link checks its token and redirects to the page with it.
    const opened = await app.request(
      new URL(state.resetLinks[0]!).pathname + new URL(state.resetLinks[0]!).search,
    );
    const token = new URL(opened.headers.get('location')!, origin).searchParams.get('token')!;
    expect(token).toBeTruthy();
    const reset = await app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token, newPassword: 'reset-password-5678-new' }),
    });
    expect(reset.status).toBe(200);

    expect((await get('/api/probe', stolen.cookie)).status).toBe(401);
    const [{ count }] = (await pool.db.execute<{ count: number }>(
      sql`select count(*)::integer as count from session where user_id = ${stolen.id}`,
    )) as unknown as [{ count: number }];
    expect(count).toBe(0);
    // The new password signs in.
    const signedIn = await auth.api.signInEmail({
      body: { email, password: 'reset-password-5678-new' },
    });
    expect(signedIn.user.id).toBe(stolen.id);
  });

  it('tells a banned person their account is suspended, not to "contact support" (#165)', async () => {
    const { BANNED_USER_MESSAGE } = await import('../../auth/index.js');
    const banned = await signedInAdmin();
    const [{ email }] = (await pool.db.execute<{ email: string }>(
      sql`update "user" set banned = true where id = ${banned.id} returning email`,
    )) as unknown as [{ email: string }];
    const response = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body).toEqual({ code: 'BANNED_USER', message: BANNED_USER_MESSAGE });
    expect(body.message).not.toMatch(/support/i);
  });

  it('costs one indexed read per request', async () => {
    const admin = await signedInAdmin();
    for (let index = 0; index < 20; index++) await get('/api/probe', admin.cookie);
    const started = performance.now();
    const rounds = 200;
    for (let index = 0; index < rounds; index++) {
      expect((await get('/api/probe', admin.cookie)).status).toBe(200);
    }
    const perRequest = (performance.now() - started) / rounds;
    console.info(`Session resolved from the database: ${perRequest.toFixed(2)} ms per request`);
    expect(perRequest).toBeLessThan(25);
  });
});
