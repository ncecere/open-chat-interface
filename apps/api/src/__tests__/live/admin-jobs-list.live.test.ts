import { schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

const { lifecycleRoutes } = await import('../../routes/admin/lifecycle.js');
const { lifecycleJobs } = await import('../../services/jobs/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

interface Listing {
  jobs: {
    name: string;
    intervalMs: number;
    lastRun: { id: string; jobName: string; status: string; errorMessage: string | null } | null;
  }[];
}

const MINUTE = 60_000;

describe.skipIf(!available)('live: System health background jobs (#215)', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/lifecycle', lifecycleRoutes);

  beforeAll(async () => {
    live = await createLiveDatabase('admin_jobs_list');
    state.db = live.db;
    const now = Date.now();
    // A daily job that failed this morning...
    await live.db.insert(schema.jobRun).values({
      jobName: 'backups.run',
      startedAt: new Date(now - 6 * 60 * MINUTE),
      finishedAt: new Date(now - 6 * 60 * MINUTE + 500),
      durationMs: 500,
      status: 'error',
      errorMessage: 'Access Denied',
    });
    await live.db.insert(schema.jobRun).values({
      jobName: 'trash.purge-expired',
      startedAt: new Date(now - 3 * 60 * MINUTE),
      finishedAt: new Date(now - 3 * 60 * MINUTE + 20),
      durationMs: 20,
      itemsProcessed: 4,
      status: 'success',
    });
    // ...then hundreds of runs of the jobs that tick every few seconds.
    const frequent = ['chat.recover-interrupted-replies', 'usage.fold-rollups', 'webhooks.deliver'];
    await live.db.insert(schema.jobRun).values(
      Array.from({ length: 300 }, (_, i) => ({
        jobName: frequent[i % frequent.length] as string,
        startedAt: new Date(now - (300 - i) * 1000),
        finishedAt: new Date(now - (300 - i) * 1000 + 5),
        durationMs: 5,
        status: 'success' as const,
      })),
    );
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lists every registered job with its latest run, however long ago', async () => {
    const response = await app.request('/lifecycle/jobs');
    expect(response.status, await response.clone().text()).toBe(200);
    const { jobs } = (await response.json()) as Listing;

    expect(jobs.map((job) => job.name).sort()).toEqual(
      lifecycleJobs()
        .map((job) => job.name)
        .sort(),
    );
    const byName = new Map(jobs.map((job) => [job.name, job]));
    // The daily job's failure is still shown, hours and 300 runs later.
    expect(byName.get('backups.run')?.lastRun).toMatchObject({
      jobName: 'backups.run',
      status: 'error',
      errorMessage: 'Access Denied',
    });
    expect(byName.get('trash.purge-expired')?.lastRun?.status).toBe('success');
    expect(byName.get('trash.purge-expired')?.intervalMs).toBe(60 * MINUTE);
    // A job that has never run is listed too, so it can be run by hand.
    expect(byName.get('storage.recompute-usage')).toMatchObject({
      intervalMs: 24 * 60 * MINUTE,
      lastRun: null,
    });
    // The frequent jobs show their newest run only.
    const newest = await live.db
      .select({ id: schema.jobRun.id, startedAt: schema.jobRun.startedAt })
      .from(schema.jobRun);
    const latestWebhookRun = newest
      .filter((row) => row.id === byName.get('webhooks.deliver')?.lastRun?.id)
      .at(0);
    expect(latestWebhookRun).toBeDefined();
    expect(Date.now() - (latestWebhookRun?.startedAt.getTime() ?? 0)).toBeLessThan(10_000);
  });
});
