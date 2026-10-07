import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// An address where nothing listens, whatever the environment provides: CI
// runs this suite with DATABASE_URL pointing at a real PostgreSQL, and
// test/setup.ts only fills it in when it is unset. Set before the app and
// its database module load.
const UNREACHABLE = 'postgres://oci_test:oci_test@127.0.0.1:1/oci_test';
process.env.DATABASE_URL = UNREACHABLE;
process.env.CONTROL_DATABASE_URL = UNREACHABLE;
const { createApp } = await import('../../app.js');
const { withReadRetry } = await import('../../middleware/read-retry.js');

/**
 * The sign-in page's requests with no database at all (#288): DATABASE_URL
 * points at port 1 (set below), as a stopped PostgreSQL looks to a replica
 * that starts or reconnects during the outage. Through the API's real
 * pipeline (app.ts, and the read retry server.ts puts around it) and the real
 * Better Auth handler. Each answers as a lost connection, which the sign-in
 * and reset pages tell apart from a wrong password or a feature turned off.
 * The status said "An unexpected error occurred", unmarked: the auth policy
 * turned the failure into its own error. auth-outage.live.test.ts covers an
 * outage that starts under a running replica.
 */
const ORIGIN = 'http://localhost:3000';
const app = createApp();
const fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));

const post = (path: string, body: Record<string, unknown>) =>
  fetchHandler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );

async function expectLostConnection(response: Response) {
  expect(response.status).toBe(500);
  expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
  expect(await response.json()).toMatchObject({
    error: { code: 'INTERNAL_ERROR', retryable: true },
  });
}

/** The cookie a signed-in browser sends: a token signed with the instance's secret. */
function signedInCookie(): string {
  const token = 'outagesessiontoken0123456789abcd';
  const signature = createHmac('sha256', process.env.AUTH_SECRET!).update(token).digest('base64');
  return `oci.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

describe('a signed-in request with the database unreachable', () => {
  // The failover drill: during a Patroni switchover the session lookup on an
  // ordinary route met "the database system is shutting down" (57P03), and
  // Better Auth's getSession re-threw it as a bare "Failed to get session",
  // so the answer was a plain 500 the client could not tell from a bug. The
  // request itself never ran, so it is a lost connection like any other.
  it('answers a read and a write as a lost connection', async () => {
    const cookie = signedInCookie();
    await expectLostConnection(
      await fetchHandler(new Request(`${ORIGIN}/api/me`, { headers: { cookie, origin: ORIGIN } })),
    );
    await expectLostConnection(
      await fetchHandler(
        new Request(`${ORIGIN}/api/threads`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Outage' }),
        }),
      ),
    );
  });
});

describe('auth requests with the database unreachable (#288)', () => {
  it('answers the sign-in page status as a lost connection', async () => {
    await expectLostConnection(await fetchHandler(new Request(`${ORIGIN}/api/auth/status`)));
  });

  it('answers a sign-in and a reset request as a lost connection', async () => {
    const email = 'm.bell@northbrook.edu';
    await expectLostConnection(
      await post('/sign-in/email', { email, password: 'the-right-password' }),
    );
    await expectLostConnection(
      await post('/request-password-reset', { email, redirectTo: '/auth/reset-password' }),
    );
  });
});
