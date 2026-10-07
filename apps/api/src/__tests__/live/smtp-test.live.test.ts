import { eq, schema } from '@oci/db';
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

/**
 * Settings → Email delivery (#115): the settings say whether SMTP credentials
 * are stored, and Send test email mails the administrator with the saved
 * settings, reporting the mail server's reason when it fails. nodemailer is
 * faked, so no mail leaves the test.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  sent: [] as Array<{ to: string; subject: string }>,
  fail: null as Error | null,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string }) => {
        if (state.fail) throw state.fail;
        state.sent.push({ to: mail.to, subject: mail.subject });
        return { messageId: 'walk' };
      },
    }),
  },
}));

const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');

function appFor(actorId: string, role: 'admin' | 'auditor') {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: actorId,
      role,
      name: 'Mail tester',
      email: `${role}-mail@example.test`,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.use('*', requireAdmin);
  app.route('/settings', settingsRoutes);
  return app;
}

describe.skipIf(!available)('live: testing email delivery', () => {
  let live: LiveDatabase;
  let admin: Hono<AppBindings>;
  let auditor: Hono<AppBindings>;

  const request = (app: Hono<AppBindings>, path: string, init: RequestInit = {}) =>
    app.request(`/settings${path}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
    });
  const smtp = async () =>
    ((await (await request(admin, '')).json()) as { smtp: Record<string, unknown> }).smtp;
  const test = async () =>
    (await (await request(admin, '/smtp/test', { method: 'POST', body: '{}' })).json()) as {
      ok: boolean;
      message: string;
    };

  beforeAll(async () => {
    live = await createLiveDatabase('smtp_test');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = appFor(await seedUser(live.db, state.organizationId, { role: 'admin' }), 'admin');
    auditor = appFor(await seedUser(live.db, state.organizationId, { role: 'auditor' }), 'auditor');
  });
  beforeEach(() => {
    state.sent = [];
    state.fail = null;
    invalidateSettingsCache();
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('says whether a username and password are stored, never what they are', async () => {
    expect(await smtp()).toMatchObject({ hasUsername: false, hasPassword: false });
    const saved = await request(admin, '', {
      method: 'PATCH',
      body: JSON.stringify({
        smtp: {
          host: 'mail.example.test',
          port: 587,
          fromAddress: 'oci@example.test',
          username: 'walk-user',
          password: 'walk-secret-password',
        },
      }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    invalidateSettingsCache();
    const after = await smtp();
    expect(after).toMatchObject({ configured: true, hasUsername: true, hasPassword: true });
    expect(JSON.stringify(after)).not.toContain('walk-secret-password');
    expect(JSON.stringify(after)).not.toContain('walk-user');
  });

  it('mails the administrator who asks, with the saved settings', async () => {
    expect(await test()).toEqual({
      ok: true,
      message: 'Sent to admin-mail@example.test. Check that it arrived.',
    });
    expect(state.sent).toEqual([
      { to: 'admin-mail@example.test', subject: expect.stringMatching(/^Test email from /) },
    ]);
  });

  it('gives the mail server’s reason when it fails, and audits both', async () => {
    state.fail = new Error('Invalid login: 535 5.7.8 Authentication failed');
    const result = await test();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid login: 535');
    const rows = await live.db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'smtp.test'));
    expect(rows.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([{ ok: true }, { ok: false }]),
    );
  });

  it('is not available to auditors', async () => {
    const response = await request(auditor, '/smtp/test', { method: 'POST', body: '{}' });
    expect(response.status).toBe(403);
    expect(state.sent).toEqual([]);
  });
});
