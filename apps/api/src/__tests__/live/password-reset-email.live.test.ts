import { createDatabase, like, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * The password reset email says how long its link works (#184), and what it
 * says is the reset token's real lifetime: the request goes through Better
 * Auth and the real email module; only the SMTP transport is captured.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  sent: [] as Array<{ to: string; text: string; html?: string }>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; text: string; html?: string }) => {
        state.sent.push(mail);
        return { messageId: 'reset' };
      },
    }),
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/branding.js', () => ({ currentAppName: async () => 'Walk3 Instance' }));
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
    if (key === 'smtp')
      return {
        host: 'mail.example.test',
        port: 587,
        secure: false,
        fromAddress: 'oci@example.test',
        username: null,
        encryptedPassword: null,
      };
    return {};
  },
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live: the password reset email', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono;
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  beforeAll(async () => {
    live = await createLiveDatabase('password_reset_email');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { auth } = await import('../../auth/index.js');
    app = new Hono();
    app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('says how long the link works, which is how long its token lasts (#184)', async () => {
    const { auth } = await import('../../auth/index.js');
    const email = 'walk3-reset@example.test';
    await auth.api.signUpEmail({
      body: { email, password: 'reset-email-password-1234', name: 'Walk3 Reset' },
    });
    const requested = await app.request('/api/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, redirectTo: '/auth/reset-password' }),
    });
    expect(requested.status).toBe(200);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    const [mail] = state.sent;

    expect(mail?.text).toContain(
      'This link works for 1 hour. After that, ask for a new one with “Forgot your password?” on the sign-in page.',
    );
    expect(mail?.html).toContain('This link works for 1 hour.');

    // The token behind the link lasts exactly that long.
    const [token] = await pool.db
      .select()
      .from(schema.verification)
      .where(like(schema.verification.identifier, 'reset-password:%'));
    const lifetimeMs = token!.expiresAt.getTime() - token!.createdAt.getTime();
    expect(Math.abs(lifetimeMs - 60 * 60_000)).toBeLessThan(5_000);
  });
});
