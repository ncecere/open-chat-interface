import { eq, schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * The README's first run: set INITIAL_ADMIN_EMAIL, leave the password unset,
 * and a one-time password is printed to the API logs. The bundled Compose file
 * passes an unset variable as an empty string, which the API used to reject at
 * startup. This runs the real bootstrap and real Better Auth against
 * PostgreSQL with exactly what Compose passes.
 */
const state = vi.hoisted(() => {
  process.env.INITIAL_ADMIN_EMAIL = 'first-admin@example.test';
  process.env.INITIAL_ADMIN_PASSWORD = '';
  return { db: null as unknown, organizationId: '' };
});
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return {
    ...actual,
    getSetting: async (key: string) =>
      key === 'auth'
        ? {
            registrationMode: 'closed',
            localAuthEnabled: true,
            emailVerificationRequired: false,
            sessionLifetimeDays: 30,
            sessionRefreshDays: 1,
          }
        : actual.getSetting(key as never),
  };
});

const available = await livePostgresAvailable();

describe.skipIf(!available)('live: the first administrator from Compose defaults', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('initial_admin');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });
  afterAll(async () => {
    delete process.env.INITIAL_ADMIN_EMAIL;
    delete process.env.INITIAL_ADMIN_PASSWORD;
    await live?.destroy();
  });

  it('starts, logs a one-time password, and that password signs in', async () => {
    const { loadEnv } = await import('../../config/env.js');
    expect(loadEnv().INITIAL_ADMIN_PASSWORD).toBeUndefined();

    const { logger } = await import('../../lib/logger.js');
    const info = vi.spyOn(logger, 'info');
    const { ensureInitialAdmin } = await import('../../bootstrap.js');
    await ensureInitialAdmin();

    const printed = info.mock.calls
      .map((call) => call.find((part) => typeof part === 'string') as string | undefined)
      .find((message) => message?.includes('Initial administrator created.'));
    expect(printed).toContain('Email:    first-admin@example.test');
    const password = printed?.match(/Password: (\S+)/)?.[1];
    expect(password?.length).toBeGreaterThanOrEqual(24);

    const [admin] = await live.db
      .select({ role: schema.user.role, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, 'first-admin@example.test'));
    expect(admin).toEqual({ role: 'admin', emailVerified: true });

    const { auth } = await import('../../auth/index.js');
    const origin = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email: 'first-admin@example.test', password }),
      }),
    );
    expect(response.status).toBe(200);

    // A second start finds the account and prints nothing new.
    info.mockClear();
    await ensureInitialAdmin();
    expect(info).not.toHaveBeenCalled();
  });
});
