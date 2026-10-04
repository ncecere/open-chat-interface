import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BackgroundMigrationDefinition,
  type BatchTransaction,
  rewriteMessagesInPlace,
  scheduleBackgroundMigrations,
} from '@oci/db';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Background migrations (v0.11 design, section 1) against real PostgreSQL.
 *
 * The probe migration increments a counter on every row it visits, which is
 * deliberately NOT idempotent: any row visited twice, or never, shows up as
 * a counter other than 1. A real migration must be idempotent; this one is
 * the instrument that proves the runner loses and repeats nothing when a
 * batch crashes, its connection is terminated, its owner dies, or another
 * worker takes over.
 */

const state = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get sql() {
    return state.sql;
  },
  get db() {
    return null;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const available = await livePostgresAvailable();
const runner = await import('../../services/migrations/background-runner.js');
const admin = await import('../../services/migrations/background-admin.js');
const readiness = await import('../../services/migrations/readiness.js');
const { databasePressure } = await import('../../services/migrations/throttle.js');

const ROWS = 2_500;

type Hook = (tx: BatchTransaction, batch: number) => Promise<void>;

function probe(hook: Hook = async () => {}): BackgroundMigrationDefinition & { batches: number } {
  const definition = {
    name: 'test.count-visits',
    release: 'test',
    table: 'public.bg_probe',
    description: 'Counts visits per row.',
    batchSize: 300,
    pauseMs: 0,
    batches: 0,
    async batch(
      tx: BatchTransaction,
      { cursor, batchSize }: { cursor: string | null; batchSize: number },
    ) {
      definition.batches += 1;
      const [row] = await tx<[{ rows: number; last: string | null }]>`
        with batch as (
          select id from bg_probe where ${cursor === null ? tx`true` : tx`id > ${cursor}`}
          order by id limit ${batchSize}
        ), updated as (
          update bg_probe p set visits = visits + 1 from batch where p.id = batch.id returning p.id
        )
        select (select count(*) from updated)::integer as rows,
               (select id from batch order by id desc limit 1) as last
      `;
      await hook(tx, definition.batches);
      return { cursor: row!.last ?? cursor, rows: row!.rows, done: row!.rows < batchSize };
    },
  };
  return definition;
}

describe.skipIf(!available)('live PostgreSQL background migrations', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  const extra: postgres.Sql[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('background_migrations');
    client = postgres(live.connectionString, { max: 4, prepare: false, onnotice: () => {} });
    state.sql = client;
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    await live?.destroy();
  });
  beforeEach(async () => {
    readiness.resetReadinessCache();
    await client`drop table if exists bg_probe`;
    await client`create table bg_probe (id text primary key, visits integer not null default 0)`;
    await client`insert into bg_probe (id) select gen_random_uuid()::text from generate_series(1, ${ROWS})`;
    await client`analyze bg_probe`;
    await client`delete from background_migration`;
  });
  afterEach(async () => {
    for (const other of extra.splice(0)) await other.end({ timeout: 1 }).catch(() => {});
  });

  const fast = { throttle: async () => null, budgetMs: 60_000, shouldStop: () => false };

  async function visits() {
    const rows = await client<{ visits: number; count: number }[]>`
      select visits, count(*)::integer as count from bg_probe group by visits order by visits`;
    return Object.fromEntries(rows.map((row) => [row.visits, row.count]));
  }
  async function row(name = 'test.count-visits') {
    const [found] = await client<
      {
        status: string;
        cursor: string | null;
        rows_processed: string;
        batches: number;
        attempts: number;
        last_error: string | null;
        lease_owner: string | null;
        throttled_reason: string | null;
        next_run_at: Date | null;
      }[]
    >`select status, cursor, rows_processed::text, batches, attempts, last_error, lease_owner,
        throttled_reason, next_run_at from background_migration where name = ${name}`;
    return found;
  }

  it('runs every row exactly once and finishes', async () => {
    const definition = probe();
    expect(await scheduleBackgroundMigrations(client, [definition])).toEqual([definition.name]);
    expect(await readiness.isBackgroundMigrationDone(definition.name)).toBe(false);
    const processed = await runner.runBackgroundMigrations({ ...fast, definitions: [definition] });
    expect(processed).toBe(ROWS);
    expect(await visits()).toEqual({ 1: ROWS });
    expect(await row()).toMatchObject({
      status: 'finished',
      rows_processed: String(ROWS),
      lease_owner: null,
    });
    // Not ready was cached for 30 s; a fresh cache sees it finished, then keeps it.
    readiness.resetReadinessCache();
    expect(await readiness.isBackgroundMigrationDone(definition.name)).toBe(true);
    await client`update background_migration set status = 'running'`;
    expect(await readiness.isBackgroundMigrationDone(definition.name)).toBe(true);
    // Nothing left: another tick does nothing.
    expect(await runner.runBackgroundMigrations({ ...fast, definitions: [definition] })).toBe(0);
  });

  it('a batch that throws is rolled back with its cursor, and redone once', async () => {
    let failed = false;
    const definition = probe(async (_tx, batch) => {
      if (batch === 4 && !failed) {
        failed = true;
        throw new Error('injected failure after updating the batch');
      }
    });
    await scheduleBackgroundMigrations(client, [definition]);
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition], retryDelayMs: 1 });
    const failedRow = await row();
    expect(failedRow).toMatchObject({
      status: 'running',
      attempts: 1,
      batches: 3,
      lease_owner: null,
    });
    expect(failedRow?.last_error).toMatch(/injected failure/);
    // Three committed batches, nothing of the fourth.
    expect(await visits()).toEqual({ 0: ROWS - 900, 1: 900 });
    await sleep(20);
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition] });
    expect(await visits()).toEqual({ 1: ROWS });
    expect(await row()).toMatchObject({ status: 'finished', attempts: 0, last_error: null });
  });

  // Cancelled from another session rather than terminated: postgres.js 3.4.9
  // throws an uncaught TypeError when a transaction's connection closes under
  // it (a query is written to the closed socket), which the failover work
  // (design section 3) covers. For the database the outcome is the same: the
  // transaction is aborted after the batch's rows were updated.
  it('a batch cancelled mid-statement loses and repeats nothing', async () => {
    const definition = probe(async (tx, batch) => {
      if (batch === 3) {
        const [self] = await tx<[{ pid: number }]>`select pg_backend_pid() as pid`;
        const killer = postgres(live.connectionString, { max: 1, onnotice: () => {} });
        extra.push(killer);
        setTimeout(() => void killer`select pg_cancel_backend(${self!.pid})`.execute(), 200);
        await tx`select pg_sleep(5)`;
      }
    });
    await scheduleBackgroundMigrations(client, [definition]);
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition], retryDelayMs: 1 });
    expect(await visits()).toEqual({ 0: ROWS - 600, 1: 600 });
    await sleep(20);
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition] });
    expect(await visits()).toEqual({ 1: ROWS });
  });

  it('a worker that died holding the lease is replaced once the lease runs out', async () => {
    const definition = probe();
    await scheduleBackgroundMigrations(client, [definition]);
    // Worker A claims and dies before running a batch: its lease blocks others.
    const claimed = await runner.claimNext(client, [definition.name], 'worker-a', 300);
    expect(claimed?.lease_owner).toBe('worker-a');
    expect(
      await runner.runBackgroundMigrations({
        ...fast,
        definitions: [definition],
        owner: 'worker-b',
      }),
    ).toBe(0);
    await sleep(400);
    expect(
      await runner.runBackgroundMigrations({
        ...fast,
        definitions: [definition],
        owner: 'worker-b',
      }),
    ).toBe(ROWS);
    expect(await visits()).toEqual({ 1: ROWS });
  });

  it('a worker whose lease was taken over stops before writing anything', async () => {
    let takeover: Promise<unknown> | undefined;
    const definition = Object.assign(
      probe(async (_tx, batch) => {
        if (batch === 1) {
          // Once batch 1 commits (the update waits for its row lock), worker B
          // owns the migration, as if A's lease had run out during the pause.
          takeover = client`update background_migration set lease_owner = 'worker-b',
            lease_until = now() + interval '1 minute'`.execute();
        }
      }),
      { pauseMs: 300 },
    );
    await scheduleBackgroundMigrations(client, [definition]);
    const processedByA = await runner.runBackgroundMigrations({
      ...fast,
      definitions: [definition],
      owner: 'worker-a',
    });
    await takeover;
    // A ran batch 1, then found B in the row and wrote nothing more.
    expect(processedByA).toBe(300);
    expect(definition.batches).toBe(1);
    expect(await visits()).toEqual({ 0: ROWS - 300, 1: 300 });
    expect(await row()).toMatchObject({ lease_owner: 'worker-b', batches: 1 });
    // B (or anyone, once B's lease runs out) continues from A's last cursor.
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition], owner: 'worker-b' });
    expect(await visits()).toEqual({ 1: ROWS });
  });

  it('stops between batches when the replica drains, handing the lease back', async () => {
    const definition = probe();
    await scheduleBackgroundMigrations(client, [definition]);
    let batches = 0;
    const counting = probe(async () => {
      batches += 1;
    });
    const processed = await runner.runBackgroundMigrations({
      ...fast,
      definitions: [counting],
      shouldStop: () => batches >= 2,
    });
    expect(processed).toBe(600);
    expect(await row()).toMatchObject({ status: 'running', lease_owner: null, batches: 2 });
    // Any replica's next tick continues from the cursor.
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition], owner: 'other' });
    expect(await visits()).toEqual({ 1: ROWS });
  });

  it('stops when its time budget is spent', async () => {
    const definition = Object.assign(probe(), { pauseMs: 200 });
    await scheduleBackgroundMigrations(client, [definition]);
    const processed = await runner.runBackgroundMigrations({
      ...fast,
      definitions: [definition],
      budgetMs: 300,
    });
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(ROWS);
    expect(await row()).toMatchObject({ status: 'running', lease_owner: null });
  });

  it('waits while the database is under pressure', async () => {
    const definition = probe();
    await scheduleBackgroundMigrations(client, [definition]);
    const processed = await runner.runBackgroundMigrations({
      ...fast,
      definitions: [definition],
      throttle: async () => 'Replication lag 30 s is over 10 s',
      throttleDelayMs: 60_000,
    });
    expect(processed).toBe(0);
    const throttled = await row();
    expect(throttled).toMatchObject({
      throttled_reason: 'Replication lag 30 s is over 10 s',
      lease_owner: null,
    });
    expect(throttled!.next_run_at!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not claimed again before next_run_at.
    expect(await runner.runBackgroundMigrations({ ...fast, definitions: [definition] })).toBe(0);
    expect(await visits()).toEqual({ 0: ROWS });
  });

  it('sees a long-running transaction and, without the pg_monitor role, no replication', async () => {
    const other = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    extra.push(other);
    const reserved = await other.reserve();
    await reserved`begin`;
    await reserved`select 1`;
    await sleep(1_200);
    const reason = await databasePressure(client, {
      maxReplicationLagMs: 10_000,
      maxTransactionAgeMs: 1_000,
    });
    expect(reason).toMatch(/A transaction has been open for 1 s \(pid \d+\), over 1 s/);
    expect(
      await databasePressure(client, { maxReplicationLagMs: 1, maxTransactionAgeMs: 0 }),
    ).toBeNull();
    await reserved`commit`;
    reserved.release();
  });

  it('is paused and resumed by an administrator, between batches', async () => {
    let paused = false;
    const definition = probe(async (_tx, batch) => {
      if (batch === 2 && !paused) {
        paused = true;
        // An administrator pauses while batch 2 runs: it waits for the batch's
        // row lock, so batch 2 commits and no batch 3 starts.
        void admin.pauseBackgroundMigration(client, 'test.count-visits');
        await sleep(100);
      }
    });
    await scheduleBackgroundMigrations(client, [definition]);
    expect(await runner.runBackgroundMigrations({ ...fast, definitions: [definition] })).toBe(600);
    await sleep(50);
    expect(await row()).toMatchObject({ status: 'paused', batches: 2, lease_owner: null });
    expect(await runner.runBackgroundMigrations({ ...fast, definitions: [definition] })).toBe(0);
    await expect(admin.pauseBackgroundMigration(client, definition.name)).rejects.toThrow(
      /A paused background migration cannot be paused/,
    );

    const resumed = await admin.resumeBackgroundMigration(client, definition.name);
    expect(resumed).toMatchObject({ status: 'running', bundled: false });
    const changed = await admin.updateBackgroundMigration(client, definition.name, {
      batchSize: 1_000,
      pauseMs: 5,
    });
    expect(changed).toMatchObject({ batchSize: 1_000, pauseMs: 5 });
    await runner.runBackgroundMigrations({ ...fast, definitions: [definition] });
    expect(await visits()).toEqual({ 1: ROWS });
    await expect(admin.resumeBackgroundMigration(client, definition.name)).rejects.toThrow(
      /A finished background migration cannot be resumed/,
    );
    await expect(admin.pauseBackgroundMigration(client, 'missing')).rejects.toThrow(
      /No background/,
    );
  });

  it('marks a migration failed after repeated failures, until resumed', async () => {
    const definition = probe(async () => {
      throw new Error('always fails');
    });
    await scheduleBackgroundMigrations(client, [definition]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await runner.runBackgroundMigrations({
        ...fast,
        definitions: [definition],
        retryDelayMs: 1,
        maxAttempts: 3,
      });
      await sleep(30);
    }
    expect(await row()).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'always fails',
    });
    expect(await runner.runBackgroundMigrations({ ...fast, definitions: [definition] })).toBe(0);
    expect(await visits()).toEqual({ 0: ROWS });
    expect(await admin.resumeBackgroundMigration(client, definition.name)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('lists scheduled, unscheduled and unknown migrations with progress', async () => {
    const definition = probe();
    await scheduleBackgroundMigrations(client, [definition]);
    await client`insert into background_migration (name, table_name, batch_size, pause_ms, status)
      values ('9.9.newer', 'public.bg_probe', 10, 0, 'running')`;
    await runner.runBackgroundMigrations({
      ...fast,
      definitions: [definition],
      shouldStop: () => definition.batches >= 2,
    });
    const unscheduled = { ...probe(), name: 'test.not-scheduled' };
    const listed = await admin.listBackgroundMigrations(client, [definition, unscheduled]);
    expect(listed.map((item) => [item.name, item.status, item.bundled])).toEqual([
      ['test.count-visits', 'running', true],
      ['9.9.newer', 'running', false],
      ['test.not-scheduled', 'not_scheduled', true],
    ]);
    const [running] = listed;
    expect(running!.rowsProcessed).toBe(600);
    expect(running!.estimatedRows).toBe(ROWS);
    expect(running!.tableBytes).toBeGreaterThan(0);
    // A UUID cursor: progress is its place in the key space.
    expect(running!.progress).toBeGreaterThan(0.1);
    expect(running!.progress).toBeLessThan(0.45);
  });

  it('the bundled test definition rewrites messages in place without changing them', async () => {
    const organizationId = await seedOrganization(live.db);
    const userId = await seedUser(live.db, organizationId);
    await client`
      insert into thread (organization_id, user_id) values (${organizationId}, ${userId})`;
    await client`
      insert into message (thread_id, user_id, role, position)
      select t.id, ${userId}, 'user', g from thread t, generate_series(1, 1500) g`;
    const before = await client`select id, updated_at, change_seq from message order by id`;
    await scheduleBackgroundMigrations(client, [rewriteMessagesInPlace]);
    const processed = await runner.runBackgroundMigrations({
      ...fast,
      definitions: [rewriteMessagesInPlace],
    });
    expect(processed).toBe(1_500);
    const after = await client`select id, updated_at, change_seq from message order by id`;
    expect(after).toEqual(before);
    expect(await row(rewriteMessagesInPlace.name)).toMatchObject({ status: 'finished' });
  });

  it('readiness reads a missing table as not ready, and post-deploy steps by name', async () => {
    const other = await createLiveDatabase('background_readiness');
    const bare = postgres(other.connectionString, { max: 1, onnotice: () => {} });
    extra.push(bare);
    try {
      await bare`drop table background_migration`;
      expect(await readiness.isBackgroundMigrationDone('x', bare)).toBe(false);
      expect(await readiness.isPostStepDone('0001_x', bare)).toBe(false);
      readiness.resetReadinessCache();
      await bare`insert into oci_post_migration (name, checksum, finished_at) values ('0001_x', 'c', now())`;
      expect(await readiness.isPostStepDone('0001_x', bare)).toBe(true);
    } finally {
      await bare.end({ timeout: 1 });
      await other.destroy();
    }
  });
});
