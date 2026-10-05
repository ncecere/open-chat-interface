import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  controlConnection,
  terminateEveryBackend,
  waitForLockWaiter,
} from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Requests in flight when the database fails over (v0.11 design, section 3),
 * through the real thread routes and the API's request pipeline. Every
 * backend is terminated while a request's query is running:
 *
 * - a read (GET) is retried once within the request and succeeds;
 * - a write (POST) is never retried automatically: it fails with a 500 that
 *   says it may be retried (503 is reserved for a draining replica);
 * - the pool reconnects afterwards, and a connection dropped inside a
 *   transaction fails the transaction instead of hanging it.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/limits/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/limits/rate-limit.js')>()),
  threadCreateRateLimit: async () => ({ allowed: true }),
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live failover during requests', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let fetchHandler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    live = await createLiveDatabase('failover_requests');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    // The API's own pipeline (server.ts): reads are retried around the app.
    const { withReadRetry } = await import('../../middleware/read-retry.js');
    fetchHandler = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  /**
   * Holds an exclusive lock on `thread` so the request's first query on it
   * waits, terminates every backend while it waits, then lets go.
   */
  async function failOverDuring(request: Request) {
    const control = controlConnection(live.connectionString);
    try {
      let response!: Promise<Response>;
      await control.begin(async (tx) => {
        await tx`lock table thread in access exclusive mode`;
        response = fetchHandler(request);
        await waitForLockWaiter(tx, '%"thread"%');
        expect(await terminateEveryBackend(tx)).toBeGreaterThanOrEqual(1);
      });
      return await response;
    } finally {
      await control.end({ timeout: 1 });
    }
  }

  it('retries a read once and answers it', async () => {
    await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Before failover' });
    const response = await failOverDuring(new Request('http://oci.test/api/threads'));
    // Before: 500, "An unexpected error occurred".
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: { title: string }[] };
    expect(body.threads.map((thread) => thread.title)).toContain('Before failover');
  });

  it('never retries a write: answers 500 marked retryable, not 503', async () => {
    const before = await pool.db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.userId, owner));
    const response = await failOverDuring(
      new Request('http://oci.test/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'During failover' }),
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
    const body = (await response.json()) as { error: { code: string; retryable?: boolean } };
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    // Not retried behind the client's back: nothing was created.
    const after = await pool.db.select().from(schema.thread).where(eq(schema.thread.userId, owner));
    expect(after).toHaveLength(before.length);
    // The client sends it again once the database is back, and it works.
    const again = await fetchHandler(
      new Request('http://oci.test/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'After failover' }),
      }),
    );
    expect(again.status).toBe(201);
  });

  it('fails a transaction whose connection dropped instead of hanging, then reconnects', async () => {
    const control = controlConnection(live.connectionString);
    try {
      const started = Date.now();
      const outcome = await pool.sql
        .begin(async (tx) => {
          const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await control`select pg_terminate_backend(${row!.pid})`;
          await tx`insert into failover_never (id) values (1)`;
        })
        .then(
          () => 'committed',
          (error: { code?: string }) => error.code,
        );
      expect(['57P01', 'CONNECTION_CLOSED']).toContain(outcome);
      expect(Date.now() - started).toBeLessThan(5_000);
      // The pool opens a new connection for the next query.
      const [row] = await pool.db.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(row?.ok).toBe(1);
    } finally {
      await control.end({ timeout: 1 });
    }
  });
});
