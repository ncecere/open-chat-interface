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
