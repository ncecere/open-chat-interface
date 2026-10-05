import { createDatabase, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { controlConnection, waitForStatement } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * A transaction whose backend is terminated, as every open transaction's is
 * on a database failover (v0.11 design, section 3), through the pinned and
 * patched postgres.js (patches/postgres@3.4.9.patch, patches/README.md).
 *
 * Unpatched, postgres.js 3.4.9 rejects the transaction, then has the
 * transaction's scope send its ROLLBACK on the closed connection: the write is
 * deferred with setImmediate and calls `socket.write` on a socket it has
 * already set to null. The TypeError ("Cannot read properties of null
 * (reading 'write')") is thrown outside any promise, so it is an
 * uncaughtException, which ends a Node process (porsager/postgres#1154).
 *
 * Two more defects of the same close path made the pool stop serving after
 * a few such failures, which the patch also fixes: the scope's handler moved
 * the closed connection into the pool's "full" queue, which nothing empties;
 * and a closed connection kept its cancelled write timer (a reconnect never
 * sent its startup message) and the FATAL error (which then failed the next
 * session's first query). So every case runs more rounds than the pool has
 * connections.
 *
 * Each round checks: the transaction rejects with a connection error, nothing
 * is thrown outside it (no uncaughtException, no unhandled rejection), and the
 * pool serves the next queries on a new connection.
 */
const available = await livePostgresAvailable();

const CONNECTION_CODES = ['57P01', 'CONNECTION_CLOSED'];
const POOL = 2;
/** More rounds than connections: a leaked or poisoned connection shows. */
const ROUNDS = POOL * 2 + 1;

describe.skipIf(!available)('live: a transaction whose backend is terminated', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let control: ReturnType<typeof controlConnection>;
  const escaped: unknown[] = [];
  const onEscape = (error: unknown) => escaped.push(error);

  beforeAll(async () => {
    live = await createLiveDatabase('pg_tx_failover');
    pool = createDatabase(live.connectionString, { max: POOL });
    control = controlConnection(live.connectionString);
    await pool.sql`create table tx_failover (id integer primary key)`;
  });
  beforeEach(() => {
    escaped.length = 0;
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
  });
  afterEach(() => {
    process.off('uncaughtException', onEscape);
    process.off('unhandledRejection', onEscape);
  });
  afterAll(async () => {
    await control?.end({ timeout: 1 });
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const terminate = (pid: number) => control`select pg_terminate_backend(${pid})`;

  /** Lets the driver's deferred writes (setImmediate) and close handling run. */
  async function afterTheDust() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function expectRecovered(outcome: Promise<unknown>) {
    const started = Date.now();
    const error = (await outcome.then(
      () => null,
      (rejection: unknown) => rejection,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(error).not.toBeNull();
    expect(CONNECTION_CODES).toContain(error?.code ?? error?.cause?.code);
    expect(Date.now() - started).toBeLessThan(5_000);
    await afterTheDust();
    // Before the patch: [TypeError: Cannot read properties of null (reading 'write')].
    expect(escaped).toEqual([]);
    const [row] = await pool.sql<{ ok: number }[]>`select 1 as ok`;
    expect(row?.ok).toBe(1);
    const [again] = await pool.db.execute<{ ok: number }>(sql`select 2 as ok`);
    expect(again?.ok).toBe(2);
    // Nothing of the transaction was committed.
    const [count] = await pool.sql<{ n: number }[]>`select count(*)::int as n from tx_failover`;
    expect(count?.n).toBe(0);
  }

  it('between statements (sql.begin)', { timeout: 30_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++)
      await expectRecovered(
        pool.sql.begin(async (tx) => {
          await tx`insert into tx_failover values (1)`;
          const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await terminate(row!.pid);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await tx`insert into tx_failover values (2)`;
        }),
      );
  });

  it('mid-statement (sql.begin)', { timeout: 30_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++)
      await expectRecovered(
        pool.sql.begin(async (tx) => {
          await tx`insert into tx_failover values (1)`;
          // Queries are lazy: start it, and hold its outcome so it is never unhandled.
          const sleeping = tx`select pg_sleep(30)`.then(
            () => null,
            (error: unknown) => error,
          );
          const pid = await waitForStatement(control, 'select pg_sleep(30)');
          await terminate(pid);
          throw await sleeping;
        }),
      );
  });

  it('mid-statement and between statements (Drizzle db.transaction)', {
    timeout: 60_000,
  }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await expectRecovered(
        pool.db.transaction(async (tx) => {
          await tx.execute(sql`insert into tx_failover values (1)`);
          const sleeping = tx.execute(sql`select pg_sleep(30)`).then(
            () => null,
            (error: unknown) => error,
          );
          const pid = await waitForStatement(control, 'select pg_sleep(30)');
          await terminate(pid);
          throw await sleeping;
        }),
      );
      await expectRecovered(
        pool.db.transaction(async (tx) => {
          await tx.execute(sql`insert into tx_failover values (1)`);
          const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          await terminate(row!.pid);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await tx.execute(sql`insert into tx_failover values (2)`);
        }),
      );
    }
  });

  it('a reserved connection (how job locks are held)', { timeout: 30_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const reserved = await pool.sql.reserve();
      try {
        const [row] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await terminate(row!.pid);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expectRecovered(reserved`select 1`);
      } finally {
        reserved.release();
      }
    }
  });
});
