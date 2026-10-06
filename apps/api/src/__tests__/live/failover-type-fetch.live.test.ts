import { connect, createServer, type Server, type Socket } from 'node:net';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * PostgreSQL stopping just as a job tick opens its lock connection (#137).
 *
 * Every new postgres.js connection reads the server's array types right after
 * start-up, from a promise the driver never awaited. A server that closed
 * the connection during that query (a database stopping, or failing over,
 * just after accepting it) made that promise reject with nothing to handle
 * it, and Node ended the worker: "write CONNECTION_CLOSED postgres:5432"
 * from `closed()`. A job tick opens a new lock connection every time, so the
 * worker met this where the API's long-lived pool did not.
 *
 * The test puts a TCP proxy between the job's lock connection and the live
 * database that closes the connection, once, as the driver sends that query.
 */
const state = vi.hoisted(() => ({ db: null as unknown, controlUrl: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...original,
    loadEnv: () => ({
      ...original.loadEnv(),
      DATABASE_URL: state.controlUrl,
      CONTROL_DATABASE_URL: state.controlUrl,
    }),
  };
});

const available = await livePostgresAvailable();

/** Forwards to PostgreSQL; when armed, closes the next connection that fetches types. */
async function typeFetchProxy(target: URL) {
  let armed = false;
  let closed = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.pipe(client);
    client.on('data', (data: Buffer) => {
      if (armed && data.includes('pg_catalog.pg_type')) {
        armed = false;
        closed++;
        // A clean close from the server's side, as a stopping server's is.
        upstream.destroy();
        client.end();
        return;
      }
      upstream.write(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url(connectionString: string) {
      const url = new URL(connectionString);
      url.hostname = '127.0.0.1';
      url.port = String(port);
      return url.toString();
    },
    arm() {
      armed = true;
    },
    get closed() {
      return closed;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe.skipIf(!available)('live connection closed while a job tick connects', () => {
  let live: LiveDatabase;
  let work: ReturnType<typeof createDatabase>;
  let proxy: Awaited<ReturnType<typeof typeFetchProxy>>;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    live = await createLiveDatabase('failover_type_fetch');
    work = createDatabase(live.connectionString, { max: 2 });
    state.db = work.db;
    proxy = await typeFetchProxy(new URL(live.connectionString));
    state.controlUrl = proxy.url(live.connectionString);
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    unhandled.length = 0;
  });
  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await proxy?.close();
    await work?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('survives the close, and the tick runs on a new connection', async () => {
    const { runExclusively } = await import('../../services/jobs/runner.js');
    const run = vi.fn(async () => 3);
    proxy.arm();
    // The driver also lost the reservation the connection was opened for, so
    // the tick never ended (and the job never ran again in this process).
    const items = await Promise.race([
      runExclusively({ name: 'test.type-fetch', intervalMs: 30_000, run }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    // Give a rejection nobody handled the turn it needs to be reported.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(proxy.closed).toBe(1);
    expect(unhandled).toEqual([]);
    expect(items).toBe(3);
    expect(run).toHaveBeenCalledOnce();
    const runs = await work.db
      .select()
      .from(schema.jobRun)
      .where(eq(schema.jobRun.jobName, 'test.type-fetch'));
    expect(runs).toMatchObject([{ status: 'success', itemsProcessed: 3 }]);
    // The lock was released on its own connection. Only this test's database:
    // pg_locks covers the whole server, where another instance may hold its own.
    const [lock] = await work.db.execute<{ held: number }>(
      sql`select count(*)::integer as held from pg_locks
          where locktype = 'advisory'
            and database = (select oid from pg_database where datname = current_database())`,
    );
    expect(lock!.held).toBe(0);
  });
});
