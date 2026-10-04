import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * The job runner's entries for three-phase migrations: background batches on
 * every replica, and post-deploy steps applied by the replica itself only
 * where it is the single instance (RUN_MIGRATIONS, or RUN_POST_MIGRATIONS).
 * Also the background-migration gauges on /metrics.
 */
const state = vi.hoisted(() => ({
  sql: null as unknown,
  env: {} as Record<string, unknown>,
}));
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
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return { ...original, loadEnv: () => ({ ...original.loadEnv(), ...state.env }) };
});

const available = await livePostgresAvailable();
const jobs = await import('../../services/migrations/jobs.js');
const { renderMetrics } = await import('../../services/observability/metrics.js');

describe.skipIf(!available)('live PostgreSQL migration jobs', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;

  beforeAll(async () => {
    live = await createLiveDatabase('migration_jobs');
    client = postgres(live.connectionString, { max: 2, prepare: false, onnotice: () => {} });
    state.sql = client;
    state.env = { DATABASE_URL: live.connectionString };
  });
  afterAll(async () => {
    delete process.env.OCI_TEST_BACKGROUND_MIGRATIONS;
    await client?.end({ timeout: 1 });
    await live?.destroy();
  });

  it('registers the background job, and the post-deploy job only for a single instance', () => {
    state.env = { DATABASE_URL: live.connectionString, RUN_MIGRATIONS: true };
    expect(jobs.migrationJobs().map((job) => job.name)).toEqual([
      'migrations.background',
      'migrations.post-deploy',
    ]);
    state.env = { DATABASE_URL: live.connectionString, RUN_MIGRATIONS: false };
    expect(jobs.migrationJobs().map((job) => job.name)).toEqual(['migrations.background']);
    state.env = {
      DATABASE_URL: live.connectionString,
      RUN_MIGRATIONS: false,
      BACKGROUND_MIGRATIONS_ENABLED: false,
    };
    expect(jobs.migrationJobs()).toEqual([]);
  });

  it('does nothing on replicas that do not apply post-deploy steps', async () => {
    state.env = { DATABASE_URL: live.connectionString, RUN_MIGRATIONS: false };
    expect(await jobs.applyPostMigrationsIfDue()).toBe(0);
    const [row] = await client<
      { count: number }[]
    >`select count(*)::integer as count from oci_post_migration`;
    expect(row!.count).toBe(0);
  });

  it('applies post-deploy steps and schedules background migrations once, on a single instance', async () => {
    process.env.OCI_TEST_BACKGROUND_MIGRATIONS = 'oci-test.rewrite-messages-in-place';
    state.env = { DATABASE_URL: live.connectionString, RUN_MIGRATIONS: true };
    expect(await jobs.postWorkPending()).toBe(true);
    const job = jobs.migrationJobs().find((entry) => entry.name === 'migrations.post-deploy')!;
    // Two steps applied, one background migration scheduled.
    expect(await job.run()).toBe(3);
    expect(await jobs.postWorkPending()).toBe(false);
    expect(await job.run()).toBe(0);

    const background = jobs
      .migrationJobs()
      .find((entry) => entry.name === 'migrations.background')!;
    await background.run();
    const [row] = await client<{ status: string }[]>`
      select status from background_migration where name = 'oci-test.rewrite-messages-in-place'`;
    expect(row!.status).toBe('finished');

    const metrics = await renderMetrics();
    expect(metrics).toContain(
      'oci_background_migration_rows_processed{migration="oci-test.rewrite-messages-in-place"} 0',
    );
    expect(metrics).toContain(
      'oci_background_migration_progress_ratio{migration="oci-test.rewrite-messages-in-place"} 1',
    );
    expect(metrics).toContain(
      'oci_background_migration_status{migration="oci-test.rewrite-messages-in-place",status="finished"} 1',
    );
  });

  it('reports a failed post-deploy run to the job runner', async () => {
    state.env = {
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      RUN_MIGRATIONS: true,
    };
    await client`delete from oci_post_migration`;
    const job = jobs.migrationJobs().find((entry) => entry.name === 'migrations.post-deploy')!;
    await expect(job.run()).rejects.toThrow();
  });
});
