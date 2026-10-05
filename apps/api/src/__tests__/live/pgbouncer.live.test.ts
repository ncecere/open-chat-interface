import { randomUUID } from 'node:crypto';
import { eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { dockerAvailable, type PgBouncer, startPgBouncer } from '../../../test/pgbouncer.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * The API behind a real PgBouncer in transaction mode (v0.11 design, section
 * 11). DATABASE_URL (the application pool) goes through PgBouncer, whose two
 * server connections change hands between clients all the time;
 * CONTROL_DATABASE_URL reaches PostgreSQL directly. Requests, job locks, LISTEN
 * for worker requests and post-deploy steps all run through the real code, and
 * at the end no session state is left on any pooled server connection.
 *
 * Reproduced first, with everything on DATABASE_URL (the code before the
 * control pool): a job's lease check ran on another server connection and
 * found its lock gone, so the job was recorded as cut short; the lock stayed
 * behind on a pooled server connection, where any client could re-enter it;
 * a worker's LISTEN never heard a request; and `migrate --post` left
 * `statement_timeout = 4h` and its advisory lock on pooled connections that
 * every request then used.
 */
const state = vi.hoisted(() => ({
  pooled: '',
  direct: '',
  role: 'all' as 'web' | 'worker' | 'all',
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...original,
    loadEnv: () => ({
      ...original.loadEnv(),
      DATABASE_URL: state.pooled,
      CONTROL_DATABASE_URL: state.direct,
      // A "replica" that is the primary itself, reached directly.
      READ_DATABASE_URL: state.direct,
      REDIS_URL: undefined,
      RUN_POST_MIGRATIONS: true,
      OCI_ROLE: state.role,
    }),
  };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/limits/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/limits/rate-limit.js')>()),
  threadCreateRateLimit: async () => ({ allowed: true }),
}));

const available = (await livePostgresAvailable()) && (await dockerAvailable());

describe.skipIf(!available)('live API behind PgBouncer in transaction mode', () => {
  let live: LiveDatabase;
  let bouncer: PgBouncer;
  let app: typeof import('../../db/index.js');
  let other: typeof import('../../db/index.js');
  let runner: typeof import('../../services/jobs/runner.js');
  let otherRunner: typeof import('../../services/jobs/runner.js');
  let owner: string;
  let organizationId: string;
  let fetchHandler: (request: Request) => Promise<Response>;
  /** Direct to PostgreSQL, for checks that must not go through the pooler. */
  let direct: postgres.Sql;

  beforeAll(async () => {
    live = await createLiveDatabase('pgbouncer');
    bouncer = await startPgBouncer(live.connectionString, { poolSize: 2 });
    state.direct = live.connectionString;
    state.pooled = bouncer.pooled(live.connectionString);
    direct = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    organizationId = await seedOrganization(live.db);
    owner = await seedUser(live.db, organizationId);
    // The default organization, as `migrate` seeds it (the reports read it).
    await live.db.execute(
      sql`insert into organization (name, slug) values ('Open Chat Interface', 'default')`,
    );

    app = await import('../../db/index.js');
    runner = await import('../../services/jobs/runner.js');
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const routes = new Hono<AppBindings>();
    routes.onError(errorHandler);
    routes.use('*', async (c, next) => {
      c.set('user', {
        id: owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId,
      });
      await next();
    });
    routes.route('/api/threads', threadRoutes);
    const { withReadRetry } = await import('../../middleware/read-retry.js');
    fetchHandler = withReadRetry((request: Request) => Promise.resolve(routes.fetch(request)));

    // A second replica: its own module state and pools, the same database.
    vi.resetModules();
    other = await import('../../db/index.js');
    otherRunner = await import('../../services/jobs/runner.js');
  }, 120_000);

  afterAll(async () => {
    await app?.sql.end({ timeout: 1 }).catch(() => undefined);
    await other?.sql.end({ timeout: 1 }).catch(() => undefined);
    await direct?.end({ timeout: 1 }).catch(() => undefined);
    await bouncer?.stop();
    await live?.destroy();
  });

  /** A query on PgBouncer's admin console (simple protocol only). */
  async function adminConsole<T>(command: string): Promise<T[]> {
    const url = new URL(bouncer.pooled(live.connectionString));
    url.pathname = '/pgbouncer';
    const admin = postgres(url.toString(), { max: 1, onnotice: () => {}, fetch_types: false });
    try {
      return (await admin.unsafe(command, [], { simple: true } as never)) as unknown as T[];
    } finally {
      await admin.end({ timeout: 1 });
    }
  }

  /** PgBouncer's own count of transactions it ran for this database. */
  async function pooledTransactions(): Promise<number> {
    const rows = await adminConsole<{ database: string; total_xact_count: string }>('SHOW STATS');
    const name = new URL(live.connectionString).pathname.slice(1);
    return Number(rows.find((row) => row.database === name)?.total_xact_count ?? 0);
  }

  /** Server connections PgBouncer holds open to this database. */
  async function pgbouncerServers(): Promise<number> {
    const rows = await adminConsole<{ database: string }>('SHOW SERVERS');
    const name = new URL(live.connectionString).pathname.slice(1);
    return rows.filter((row) => row.database === name).length;
  }

  /** Advisory locks still held by any session of this database. */
  async function advisoryLocksHeld(): Promise<number> {
    const [row] = await direct<{ held: number }[]>`
      select count(*)::int as held from pg_locks
      where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = current_database())
    `;
    return row?.held ?? 0;
  }

  it('serves requests through the pooler', async () => {
    const before = await pooledTransactions();
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        fetchHandler(
          new Request('http://oci.test/api/threads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: `Through PgBouncer ${n}` }),
          }),
        ),
      ),
    );
    expect(created.map((response) => response.status)).toEqual(Array(12).fill(201));
    const listed = await Promise.all(
      Array.from({ length: 12 }, () => fetchHandler(new Request('http://oci.test/api/threads'))),
    );
    expect(listed.map((response) => response.status)).toEqual(Array(12).fill(200));
    const body = (await listed[0]!.json()) as { threads: { title: string }[] };
    expect(
      body.threads.filter((thread) => thread.title.startsWith('Through PgBouncer')),
    ).toHaveLength(12);
    // Transaction-scoped work: a transaction with SET LOCAL and an advisory
    // transaction lock, as quota reservations and the migrator use.
    await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', '1234', true)`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pgbouncer-test'))`);
    });
    expect(await pooledTransactions()).toBeGreaterThan(before + 24);
  });

  it('keeps job locks on control connections: one runs, its lease holds, nothing stays locked', async () => {
    const name = `test.pgbouncer.${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const checks: boolean[] = [];
    const first = runner.runExclusively({
      name,
      intervalMs: 1000,
      run: async () => {
        entered();
        await gate;
        // Busy pooled connections between checks, as a job's batches make.
        for (let n = 0; n < 5; n++) {
          await Promise.all(
            Array.from({ length: 6 }, () => app.db.execute(sql`select pg_backend_pid()`)),
          );
          checks.push(await runner.jobMayContinue());
        }
        return 5;
      },
    });
    await inside;
    // The other replica cannot take the job while the first holds it.
    expect(
      await otherRunner.runExclusively({ name, intervalMs: 1000, run: async () => 1 }),
    ).toBeNull();
    release();
    expect(await first).toBe(5);
    expect(checks).toEqual([true, true, true, true, true]);
    const [record] = await live.db
      .select()
      .from(schema.jobRun)
      .where(eq(schema.jobRun.jobName, name));
    expect(record).toMatchObject({ status: 'success', itemsProcessed: 5 });
    expect(await advisoryLocksHeld()).toBe(0);
    // And it can be run again at once, by either replica.
    expect(await otherRunner.runExclusively({ name, intervalMs: 1000, run: async () => 2 })).toBe(
      2,
    );
  });

  it('hears worker requests through a control connection', async () => {
    state.role = 'web';
    const requests = await import('../../services/jobs/requests.js');
    const heard: unknown[] = [];
    const stop = await requests.listenForJobRequests(async (request) => {
      heard.push(request);
    });
    try {
      await vi.waitFor(
        async () => {
          // NOTIFY goes through the pooler (the web replica's application pool).
          requests.kickJob('retention.share-links');
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(heard).toContainEqual({ job: 'retention.share-links' });
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      state.role = 'all';
      await stop();
    }
  }, 20_000);

  it('applies post-deploy steps on a control connection, leaving no session state behind', async () => {
    const { applyPostMigrationsIfDue } = await import('../../services/migrations/jobs.js');
    expect(await applyPostMigrationsIfDue()).toBeGreaterThan(0);
    const [steps] = await direct<{ unfinished: number }[]>`
      select count(*) filter (where finished_at is null)::int as unfinished from oci_post_migration`;
    expect(steps?.unfinished).toBe(0);
  });

  it('runs background migration batches and the rollup fold through the pooler', async () => {
    // Scheduled by the post-deploy run above; each batch is one transaction on
    // the application pool (SET LOCAL timeouts, a row lease, the cursor).
    const { migrationJobs } = await import('../../services/migrations/jobs.js');
    const background = migrationJobs().find((job) => job.name === 'migrations.background');
    expect(background).toBeDefined();
    await vi.waitFor(
      async () => {
        await runner.runExclusively(background!);
        const rows = await direct<{ status: string }[]>`select status from background_migration`;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.status === 'finished')).toBe(true);
      },
      { timeout: 20_000, interval: 200 },
    );
    // pg_try_advisory_xact_lock, inside one transaction.
    const { foldUsageRollups } = await import('../../services/usage-report/rollup-fold.js');
    await expect(foldUsageRollups()).resolves.toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('answers administrative reports from the read replica once it is known to be current', async () => {
    const read = await import('../../db/read.js');
    const { overviewRoutes } = await import('../../routes/admin/overview.js');
    const { usageRoutes } = await import('../../routes/admin/usage.js');
    const routes = new Hono<AppBindings>();
    routes.route('/overview', overviewRoutes);
    routes.route('/usage', usageRoutes);
    try {
      // The first read starts the checks and goes to the primary.
      expect((await routes.request('/overview')).status).toBe(200);
      await vi.waitFor(() => expect(read.readRoutingStatus()?.inUse).toBe(true), {
        timeout: 5_000,
        interval: 100,
      });
      for (const path of ['/overview', '/usage/overview', '/usage/spend', '/usage/storage'])
        expect((await routes.request(path)).status, path).toBe(200);
      expect(read.readRoutingStatus()?.routed.replica).toBeGreaterThanOrEqual(4);
      const body = (await (await routes.request('/overview')).json()) as {
        threads: { total: number };
      };
      expect(body.threads.total).toBeGreaterThanOrEqual(12);
    } finally {
      await read.closeReadReplica();
    }
  });

  it('leaves no session state on any pooled server connection', async () => {
    expect.soft(await advisoryLocksHeld()).toBe(0);
    // Hold every server connection PgBouncer has at once, so each is inspected.
    const servers = await pgbouncerServers();
    expect(servers).toBeGreaterThanOrEqual(1);
    const pooled = postgres(state.pooled, { max: servers, onnotice: () => {} });
    try {
      const settings = await Promise.all(
        Array.from({ length: servers }, () =>
          pooled.begin(async (tx) => {
            await tx`select pg_sleep(0.5)`;
            const [row] = await tx<
              {
                pid: number;
                statement_timeout: string;
                lock_timeout: string;
                idle: string;
                listening: number;
              }[]
            >`
              select pg_backend_pid() as pid,
                current_setting('statement_timeout') as statement_timeout,
                current_setting('lock_timeout') as lock_timeout,
                current_setting('idle_in_transaction_session_timeout') as idle,
                (select count(*)::int from pg_listening_channels()) as listening
            `;
            return row!;
          }),
        ),
      );
      expect(new Set(settings.map((row) => row.pid)).size).toBe(servers);
      // The defaults, as a fresh direct session sees them.
      const [defaults] = await direct<
        { statement_timeout: string; lock_timeout: string; idle: string }[]
      >`
        select current_setting('statement_timeout') as statement_timeout,
          current_setting('lock_timeout') as lock_timeout,
          current_setting('idle_in_transaction_session_timeout') as idle`;
      for (const row of settings) expect.soft(row).toMatchObject({ ...defaults, listening: 0 });
    } finally {
      await pooled.end({ timeout: 1 });
    }
  });
});
