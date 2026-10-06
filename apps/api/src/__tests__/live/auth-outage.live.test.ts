import { sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outageProxy } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * Sign-in and password reset while the database cannot be reached (#288),
 * through the API's real pipeline (app.ts and the read retry around it in
 * server.ts), the real Better Auth handler and real settings, with the
 * database behind a TCP proxy that is cut as a stopped PostgreSQL would be.
 *
 * Better Auth answered a failed query itself with an empty `500`, marked
 * retryable only when a connection dropped during that very request, and the
 * authentication policy turned an unreachable database into
 * `503 AUTH_POLICY_UNAVAILABLE` (which takes a replica out of the proxy's
 * rotation). Every one now answers as a lost connection does everywhere else,
 * which the sign-in page tells apart from a wrong password.
 */
const available = await livePostgresAvailable();
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';
const LOST_CONNECTION = {
  error: {
    code: 'INTERNAL_ERROR',
    message:
      'The connection to the database was interrupted. Try again; if you were saving something, check whether it was saved first.',
    retryable: true,
  },
};

describe.skipIf(!available)(
  'live: auth requests during a database outage',
  { timeout: 90_000 },
  () => {
    let live: LiveDatabase;
    let proxy: Awaited<ReturnType<typeof outageProxy>>;
    let fetchHandler: (request: Request) => Promise<Response>;
    let invalidateSettingsCache: (key?: 'auth' | 'rateLimits') => void;
    const email = 'fix5-outage@example.com';

    beforeAll(async () => {
      live = await createLiveDatabase('auth_outage');
      proxy = await outageProxy(live.connectionString);
      // The application pool (db/index.ts) connects through the proxy; set
      // before anything reads the environment.
      process.env.DATABASE_URL = proxy.url;
      const { createApp } = await import('../../app.js');
      const { withReadRetry } = await import('../../middleware/read-retry.js');
      const { auth } = await import('../../auth/index.js');
      const settings = await import('../../services/settings.js');
      invalidateSettingsCache = settings.invalidateSettingsCache;
      await settings.updateSetting('auth', {
        registrationMode: 'open',
        emailVerificationRequired: false,
        localAuthEnabled: true,
      });
      await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Fix5 Outage' } });
      await live.db.execute(sql`update "user" set email_verified = true`);
      const app = createApp();
      fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));
    });
    afterAll(async () => {
      await proxy?.close();
      await live?.destroy();
    });

    const post = (path: string, body: Record<string, unknown>) =>
      fetchHandler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify(body),
        }),
      );
    const signIn = (password: string) => post('/sign-in/email', { email, password });
    const requestReset = () =>
      post('/request-password-reset', { email, redirectTo: '/auth/reset-password' });
    const status = () => fetchHandler(new Request(`${ORIGIN}/api/auth/status`));

    async function expectLostConnection(response: Response) {
      expect(response.status).toBe(500);
      expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
      expect(await response.json()).toEqual(LOST_CONNECTION);
    }

    // One outage, in order: each step relies on the one before it.
    it('refuses a wrong password as one while the database is up', async () => {
      const wrong = await signIn('not-the-password');
      expect(wrong.status).toBe(401);
      // The sign-in page words this one as the user guide does (#97).
      expect(await wrong.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
      expect((await status()).status).toBe(200);
    });

    it('answers a lost connection when the queries Better Auth runs itself fail', async () => {
      await proxy.cut();
      // Settings still cached. Before: an empty 500 with no retryable marker
      // for the sign-in with the right password.
      await expectLostConnection(await signIn(PASSWORD));
      await expectLostConnection(await requestReset());
      await expectLostConnection(await status());
    });

    it('answers a lost connection, not 503, when the auth policy cannot be read', async () => {
      // The rate limits still cached. Before: 503 AUTH_POLICY_UNAVAILABLE for
      // the sign-up, and "An unexpected error occurred" for the status.
      invalidateSettingsCache('auth');
      await expectLostConnection(
        await post('/sign-up/email', {
          email: 'fix5-new@example.com',
          password: PASSWORD,
          name: 'N',
        }),
      );
      await expectLostConnection(await status());
    });

    it('answers a lost connection when nothing is cached', async () => {
      // The rate limiter's own read fails first.
      invalidateSettingsCache();
      await expectLostConnection(await signIn(PASSWORD));
      await expectLostConnection(await requestReset());
      await expectLostConnection(await status());
    });

    it('signs the same person in once the database is back', async () => {
      await proxy.restore();
      expect((await signIn(PASSWORD)).status).toBe(200);
    });
  },
);
