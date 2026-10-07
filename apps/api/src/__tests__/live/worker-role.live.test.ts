import { createDatabase, eq, schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { controlConnection, terminateEveryBackend } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * A `web` replica asking a worker to start work (v0.11 design, item 14),
 * through real PostgreSQL notifications: a kick reaches the worker and runs
 * the job there under its lock; a manual run is refused while no replica runs
 * jobs and carried to the worker once one does; and the worker keeps hearing
 * requests after a failover drops its listening connection.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  connectionString: '',
  role: 'web' as 'web' | 'worker' | 'all',
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/role.js', () => ({
  processRole: () => state.role,
  runsBackgroundJobs: () => state.role !== 'web',
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
      DATABASE_URL: state.connectionString,
      REDIS_URL: undefined,
    }),
  };
});

const available = await livePostgresAvailable();

describe.skipIf(!available)('live web-to-worker job requests', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let requests: typeof import('../../services/jobs/requests.js');
  let jobs: typeof import('../../services/jobs/index.js');
  let stopListening: () => Promise<void>;
  const heard: unknown[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('worker_role');
    state.connectionString = live.connectionString;
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.sql = pool.sql;
    requests = await import('../../services/jobs/requests.js');
    jobs = await import('../../services/jobs/index.js');
    // The worker: what it hears, it handles as the real worker does.
    stopListening = await requests.listenForJobRequests(async (request) => {
      heard.push(request);
      return jobs.handleJobRequest(request);
    });
  });
  afterAll(async () => {
    await stopListening?.();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function runs(job: string) {
    return pool.db.select().from(schema.jobRun).where(eq(schema.jobRun.jobName, job));
  }

  it('runs a kicked job on the worker, not on the web replica', async () => {
    state.role = 'web';
    const runHere = vi.fn();
    requests.kickJob('quota.sweep-reservations', runHere);
    await vi.waitFor(
      async () =>
        expect(await runs('quota.sweep-reservations')).toMatchObject([{ status: 'success' }]),
      { timeout: 5_000, interval: 50 },
    );
    expect(runHere).not.toHaveBeenCalled();
    expect(heard).toContainEqual({ job: 'quota.sweep-reservations' });
  });

  it('refuses a manual run while no replica runs jobs, and carries it once one does', async () => {
    state.role = 'web';
    const actor = { id: 'admin-1', email: 'admin@oci.test' };
    expect(await requests.requestManualRun({ job: 'retention.share-links', actor })).toBe(
      'no-worker',
    );
    await expect(jobs.runOrQueueJobNow('retention.share-links')).rejects.toMatchObject({
      status: 409,
    });
    // A worker's sweep ran just now: some replica runs jobs.
    await pool.db.insert(schema.jobRun).values({ jobName: 'chat.recover-interrupted-replies' });
    expect(await jobs.runOrQueueJobNow('retention.share-links')).toBe('queued');
    // An unknown job is a 404, not a quiet skip (#82).
    await expect(jobs.runOrQueueJobNow('no.such-job')).rejects.toMatchObject({ status: 404 });
    await vi.waitFor(
      async () =>
        expect(await runs('retention.share-links')).toMatchObject([{ status: 'success' }]),
      { timeout: 5_000, interval: 50 },
    );
    // On a replica that runs jobs, "Run now" runs it right there.
    state.role = 'all';
    expect(await jobs.runOrQueueJobNow('retention.share-links')).toBe(0);
    await expect(jobs.runOrQueueJobNow('no.such-job')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps hearing requests after a failover drops its listening connection', async () => {
    state.role = 'web';
    const control = controlConnection(live.connectionString);
    try {
      expect(await terminateEveryBackend(control)).toBeGreaterThanOrEqual(1);
    } finally {
      await control.end({ timeout: 1 });
    }
    const before = heard.length;
    // postgres.js listens again once it has reconnected; until then a kick
    // is simply not heard (the job's tick is the fallback), so keep asking.
    await vi.waitFor(
      async () => {
        requests.kickJob('storage.recompute-usage');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(heard.slice(before)).toContainEqual({ job: 'storage.recompute-usage' });
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 20_000);
});
