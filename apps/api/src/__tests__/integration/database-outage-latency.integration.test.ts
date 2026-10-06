import { expect, it } from 'vitest';

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
 * How long requests take to fail while the database stays away. Every
 * connection attempt here is refused at once, as a stopped PostgreSQL's
 * name fails to resolve at once, yet in a QA walk's outage the API took
 * 12-16 s to answer after the first ~25 s: postgres.js waits before each new
 * attempt, longer after each failure in the pool (up to 20 s), until a
 * connection succeeds. That wait is now at most 2 s
 * (packages/db/src/client.ts), so a request (a read runs once more on a lost
 * connection) answers within a few seconds however long the outage lasts.
 * Through the API's real pipeline and pool, as server.ts runs it.
 */
const ORIGIN = 'http://localhost:3000';
const app = createApp();
const fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));

it('answers promptly however long the database has been unreachable', async () => {
  const started = performance.now();
  const slowest: number[] = [];
  // Rounds of a few requests at once, as pages poll during an outage. Each
  // refused attempt counts, so within two or three rounds the old wait was
  // 10-20 s per connection.
  for (let round = 0; round < 6; round++) {
    const roundStarted = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => fetchHandler(new Request(`${ORIGIN}/api/auth/status`))),
    );
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
    }
    slowest.push((performance.now() - roundStarted) / 1000);
  }
  // A request makes a few queries, and a read runs once more, each waiting
  // at most 2 s for a connection: about 4 s at worst here, where a single
  // wait used to reach 10-20 s.
  expect(Math.max(...slowest)).toBeLessThan(8);
  expect((performance.now() - started) / 1000).toBeLessThan(40);
}, 240_000);
