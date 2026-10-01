import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import type { JobDefinition } from '../../services/jobs/runner.js';

const state = vi.hoisted(() => ({ db: null as unknown, connectionString: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...original,
    loadEnv: () => ({ ...original.loadEnv(), DATABASE_URL: state.connectionString }),
  };
});

const available = await livePostgresAvailable();
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.skipIf(!available)('live PostgreSQL job lock ownership', () => {
  let live: LiveDatabase;
  let work: ReturnType<typeof createDatabase>;
  let run: typeof import('../../services/jobs/runner.js')['runExclusively'];
  let otherReplica: typeof run;
  beforeAll(async () => {
    live = await createLiveDatabase('job_locks');
    state.connectionString = live.connectionString;
    ({ runExclusively: run } = await import('../../services/jobs/runner.js'));
    // Independent module-local state, just like another API process. Both still
    // coordinate through the real database, not an in-memory mutex.
    vi.resetModules();
    ({ runExclusively: otherReplica } = await import('../../services/jobs/runner.js'));
  });
  beforeEach(() => {
    work = createDatabase(live.connectionString, { max: 3 });
    state.db = work.db;
  });
  afterEach(async () => {
    await work.sql.end({ timeout: 1 });
    await live.db.execute(sql`alter table job_run drop constraint if exists injected_job_failure`);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  function job(runBody: JobDefinition['run']): JobDefinition {
    return { name: `test.${randomUUID()}`, intervalMs: 1000, run: runBody };
  }
  async function records(name: string) {
    return live.db.select().from(schema.jobRun).where(eq(schema.jobRun.jobName, name));
  }
  async function expectUnlocked(name: string) {
    const probe = createDatabase(live.connectionString, { max: 1 }).sql;
    try {
      const [row] = await probe<
        { locked: boolean }[]
      >`select pg_try_advisory_lock(hashtext(${`oci:job:${name}`})) as locked`;
      expect(row?.locked).toBe(true);
    } finally {
      await probe.end({ timeout: 1 });
    }
  }

  it('does not reenter the same session lock on a second replica while the first runs', async () => {
    const entered = gate();
    const finish = gate();
    const task = job(async () => {
      entered.open();
      await finish.promise;
      return 7;
    });
    const first = run(task);
    try {
      await entered.promise;
      const rival = vi.fn(async () => 99);
      expect(await otherReplica({ ...task, run: rival })).toBeNull();
      expect(rival).not.toHaveBeenCalled();
      expect(await records(task.name)).toHaveLength(1);
    } finally {
      finish.open();
      await first;
    }
    expect(await records(task.name)).toMatchObject([{ status: 'success', itemsProcessed: 7 }]);
    await expectUnlocked(task.name);
    expect(await otherReplica({ ...task, run: async () => 2 })).toBe(2);
  });

  it('unlocks its owner even when the work pool hands out a different connection', async () => {
    let borrowed: Awaited<ReturnType<typeof work.sql.reserve>> | undefined;
    const task = job(async () => {
      // The broken implementation leaves the owner available in this pool.
      // Borrowing it forces its pooled unlock query onto a different session.
      borrowed = await work.sql.reserve();
      await borrowed`select pg_backend_pid()`;
      return 3;
    });
    try {
      expect(await run(task)).toBe(3);
      await expectUnlocked(task.name);
    } finally {
      borrowed?.release();
    }
  });

  it('cleans up when the run-record insert fails before the job starts', async () => {
    await live.db.execute(
      sql`alter table job_run add constraint injected_job_failure check (status <> 'running')`,
    );
    const body = vi.fn(async () => 1);
    const task = job(body);
    await expect(run(task)).rejects.toThrow();
    expect(body).not.toHaveBeenCalled();
    expect(await records(task.name)).toHaveLength(0);
    await expectUnlocked(task.name);
    await live.db.execute(sql`alter table job_run drop constraint injected_job_failure`);
    expect(await run(task)).toBe(1);
  });

  it('records a failed body and releases the lock for a retry', async () => {
    const task = job(async () => {
      throw new Error('Injected job failure');
    });
    expect(await run(task)).toBe(0);
    expect(await records(task.name)).toMatchObject([
      { status: 'error', errorMessage: 'Injected job failure' },
    ]);
    await expectUnlocked(task.name);
    expect(await run({ ...task, run: async () => 4 })).toBe(4);
  });

  it('releases the lock after success-record persistence fails', async () => {
    await live.db.execute(
      sql`alter table job_run add constraint injected_job_failure check (status <> 'success') not valid`,
    );
    const task = job(async () => 4);
    expect(await run(task)).toBe(0);
    expect(await records(task.name)).toMatchObject([{ status: 'error' }]);
    await expectUnlocked(task.name);
  });

  it('releases the lock even when persisting the error record also fails', async () => {
    await live.db.execute(
      sql`alter table job_run add constraint injected_job_failure check (status <> 'error') not valid`,
    );
    const task = job(async () => {
      throw new Error('Injected body failure');
    });
    expect(await run(task)).toBe(0);
    expect(await records(task.name)).toMatchObject([{ status: 'running' }]);
    await expectUnlocked(task.name);
  });

  it('respects an existing external owner without creating a run record', async () => {
    const owner = createDatabase(live.connectionString, { max: 1 }).sql;
    const body = vi.fn(async () => 1);
    const task = job(body);
    try {
      await owner`select pg_advisory_lock(hashtext(${`oci:job:${task.name}`}))`;
      expect(await run(task)).toBeNull();
      expect(body).not.toHaveBeenCalled();
      expect(await records(task.name)).toHaveLength(0);
    } finally {
      await owner.end({ timeout: 1 });
    }
    expect(await run(task)).toBe(1);
  });

  it.each(['error', 'false'])(
    'closes the private owner when PostgreSQL unlock returns %s',
    async (failure) => {
      // The exact integer overload shadows pg_catalog's bigint overload for
      // hashtext(). This injects a real server response, not a mocked client.
      await live.db.execute(
        sql.raw(`
      create function public.pg_advisory_unlock(integer) returns boolean
      language plpgsql as $$ begin
        ${failure === 'error' ? "raise exception 'Injected unlock failure';" : 'return false;'}
      end $$
    `),
      );
      const task = job(async () => 8);
      try {
        expect(await run(task)).toBe(8);
        expect(await records(task.name)).toMatchObject([{ status: 'success' }]);
        await expectUnlocked(task.name);
      } finally {
        await live.db.execute(sql`drop function public.pg_advisory_unlock(integer)`);
      }
    },
  );

  it('does not consume work-pool capacity with locks for different jobs', async () => {
    await work.sql.end({ timeout: 1 });
    work = createDatabase(live.connectionString, { max: 1 });
    state.db = work.db;
    const tasks = Array.from({ length: 4 }, () =>
      job(async () => {
        const [result] = await work.db.execute<{ value: number }>(sql`select 1 as value`);
        return result!.value;
      }),
    );
    expect(await Promise.all(tasks.map((task) => run(task)))).toEqual([1, 1, 1, 1]);
    for (const task of tasks) await expectUnlocked(task.name);
  });
});
