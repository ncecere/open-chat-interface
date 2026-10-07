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
vi.mock('../../services/email.js', () => ({ sendInviteEmail: async () => ({ delivered: true }) }));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'auth'
      ? { localAuthEnabled: true, registrationMode: 'invite_only' }
      : { appName: 'Walk' },
}));
vi.mock('../../auth/policy.js', () => ({ isEmailVerificationEnforced: async () => false }));
// Accepting never reaches account creation in these tests.
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));

const { inviteRoutes } = await import('../../routes/admin/invites.js');
const { acceptInvitation } = await import('../../services/invitations.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: invitations', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  async function invite(body: Record<string, unknown>) {
    const response = await app.request('/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        url?: string;
        error: { message: string; details?: unknown };
      },
    };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_invites');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    await seedUser(live.db, state.organizationId, { role: 'user', email: 'p.nair@northbrook.edu' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Invites admin',
        email: 'invites-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/invites', inviteRoutes);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('refuses to invite an address that already has an account', async () => {
    const { status, body } = await invite({ email: 'P.Nair@northbrook.edu', role: 'admin' });
    expect(status).toBe(409);
    expect(body.error.message).toContain('already exists');
    // About the address, so the form shows it at its Email field (#302).
    expect(body.error.details).toEqual([{ path: ['email'], message: body.error.message }]);
  });

  it('allows one pending invitation per address', async () => {
    expect((await invite({ email: 'walk.new@northbrook.edu', role: 'user' })).status).toBe(201);
    const second = await invite({ email: 'walk.new@northbrook.edu', role: 'admin' });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('Revoke it first');
    expect(second.body.error.details).toEqual([
      { path: ['email'], message: second.body.error.message },
    ]);
  });

  it('reports an out-of-range expiry and an address that already has an account together (#346)', async () => {
    const { status, body } = await invite({
      email: 'P.Nair@northbrook.edu',
      role: 'user',
      expiresInDays: 400,
    });
    expect(status).toBe(422);
    const details = body.error.details as Array<{ path: string[]; message: string }>;
    expect(details.map((issue) => issue.path[0]).sort()).toEqual(['email', 'expiresInDays']);
    expect(details.find((issue) => issue.path[0] === 'email')?.message).toContain('already exists');
    // Nothing was created by the refusal, and with the days fixed the address is still refused.
    const again = await invite({ email: 'P.Nair@northbrook.edu', role: 'user', expiresInDays: 7 });
    expect(again.status).toBe(409);
  });

  it('reports a pending invitation and a bad expiry together, and a bad expiry alone as before', async () => {
    expect((await invite({ email: 'walk.two@northbrook.edu' })).status).toBe(201);
    const both = await invite({ email: 'walk.two@northbrook.edu', expiresInDays: 0 });
    expect(both.status).toBe(422);
    expect(
      (both.body.error.details as Array<{ path: string[] }>).map((issue) => issue.path[0]).sort(),
    ).toEqual(['email', 'expiresInDays']);
    const alone = await invite({ email: 'walk.fresh@northbrook.edu', expiresInDays: 400 });
    expect(alone.status).toBe(422);
    expect(
      (alone.body.error.details as Array<{ path: string[] }>).map((issue) => issue.path[0]),
    ).toEqual(['expiresInDays']);
  });

  it('says when an invitation is for a different address', async () => {
    const { body } = await invite({ email: 'walk.bound@northbrook.edu', role: 'user' });
    const token = decodeURIComponent(String(body.url).split('#token=')[1] ?? '');
    await expect(
      acceptInvitation({
        token,
        email: 'someone.else@northbrook.edu',
        password: 'Walk-password-123',
        name: 'Someone',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('sent to a different email address'),
    });
  });
});
