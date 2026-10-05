import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { controlConnection, gate, terminateEveryBackend } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import type { JobDefinition } from '../../services/jobs/runner.js';

/**
 * A database failover while a background job holds its advisory lock (v0.11
 * design, section 3). The lock lives on its own session, so a failover
 * releases it: another replica may take the job over at once. The job that
 * lost it must notice at its next check between batches and stop, rather
 * than carry on as though it still held the lock, and the next tick takes
 * the lock again on the new primary.
 */
const state = vi.hoisted(() => ({ db: null as unknown, connectionString: '' }));
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
    loadEnv: () => ({ ...original.loadEnv(), DATABASE_URL: state.connectionString }),
  };
});

const available = await livePostgresAvailable();

describe.skipIf(!available)('live failover while a job holds its lock', () => {
  let live: LiveDatabase;
  let work: ReturnType<typeof createDatabase>;
  let runner: typeof import('../../services/jobs/runner.js');
  let otherReplica: typeof import('../../services/jobs/runner.js')['runExclusively'];

  beforeAll(async () => {
    live = await createLiveDatabase('failover_jobs');
    state.connectionString = live.connectionString;
    work = createDatabase(live.connectionString, { max: 3 });
    state.db = work.db;
    await live.db.execute(
      sql`create table failover_batch (job text not null, batch integer not null, replica text not null)`,
    );
    runner = await import('../../services/jobs/runner.js');
    vi.resetModules();
    ({ runExclusively: otherReplica } = await import('../../services/jobs/runner.js'));
  });
  afterAll(async () => {
    await work?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function batches(job: string) {
    const rows = await work.db.execute<{ batch: number; replica: string }>(
      sql`select batch, replica from failover_batch where job = ${job} order by batch, replica`,
    );
    return Array.from(rows);
  }

  it('stops at the next check after its lock connection dies; the next tick re-acquires', async () => {
    const name = `test.failover.${randomUUID()}`;
    const firstBatchDone = gate();
    const proceed = gate();
    const job: JobDefinition = {
      name,
      intervalMs: 1_000,
      run: async () => {
        let done = 0;
        for (let batch = 1; batch <= 3; batch++) {
          // The check between batches.
          if (batch > 1 && !(await runner.jobMayContinue())) break;
          await work.db.execute(
            sql`insert into failover_batch values (${name}, ${batch}, 'first')`,
          );
          done++;
          if (batch === 1) {
            firstBatchDone.open();
            await proceed.promise;
          }
        }
        return done;
      },
    };
    const first = runner.runExclusively(job);
    await firstBatchDone.promise;

    const control = controlConnection(live.connectionString);
    try {
      expect(await terminateEveryBackend(control)).toBeGreaterThanOrEqual(1);
    } finally {
      await control.end({ timeout: 1 });
    }
    // The failover released the lock: another replica takes the job over.
    const rival = await otherReplica({
      ...job,
      run: async () => {
        await work.db.execute(sql`insert into failover_batch values (${name}, 2, 'rival')`);
        return 1;
      },
    });
    expect(rival).toBe(1);

    proceed.open();
    await first;
    // Before: the first replica ran batches 2 and 3 as well, alongside the rival.
    expect(await batches(name)).toEqual([
      { batch: 1, replica: 'first' },
      { batch: 2, replica: 'rival' },
    ]);
    const records = await work.db
      .select()
      .from(schema.jobRun)
      .where(eq(schema.jobRun.jobName, name))
      .orderBy(schema.jobRun.startedAt);
    // The batch it finished is counted; the run is reported as cut short.
    expect(records[0]).toMatchObject({ status: 'error', itemsProcessed: 1 });
    expect(records[0]?.errorMessage).toMatch(/lost its lock/i);

    // The next tick takes the lock again, on whatever is now the primary.
    expect(await runner.runExclusively({ ...job, run: async () => 5 })).toBe(5);
  }, 30_000);
});
