import { and, createControlClient, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * System health's Background jobs, served by a `web` replica that migrates at
 * startup (so its own settings register `migrations.post-deploy`) while the
 * worker that runs jobs does not (#256): the list and Run follow the worker,
 * as its heartbeat reports it. Real routes, job registry and database; Redis
 * is a small in-memory stand-in holding the heartbeats.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => {
  // The web replica of the QA stack: RUN_MIGRATIONS=true, so post-deploy work is "its" job.
  process.env.RUN_POST_MIGRATIONS = 'true';
  return { db: null as unknown, redis: null as unknown, url: '' };
});
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// Run waits for the worker to take the request on a LISTEN connection (#265).
vi.mock('../../db/control.js', () => ({
  openControlClient: () => createControlClient(state.url),
}));
vi.mock('../../lib/role.js', () => ({
  processRole: () => 'web',
  runsBackgroundJobs: () => false,
}));
vi.mock('../../services/chat-streams.js', () => ({ sharedRedis: async () => state.redis }));

const { lifecycleRoutes } = await import('../../routes/admin/lifecycle.js');
const { lifecycleJobs } = await import('../../services/jobs/index.js');
const { startReplicaHeartbeat } = await import('../../services/jobs/workers.js');
const { listenForJobRequests, manualRunAck } = await import('../../services/jobs/requests.js');
const { POST_MIGRATIONS_JOB } = await import('../../services/migrations/jobs.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

/** The sorted set and keys the heartbeat writes, and the reads liveReplicas makes. */
function fakeRedis() {
  const scores = new Map<string, number>();
  const values = new Map<string, string>();
  const multi = () => {
    const ops: Array<() => void> = [];
    const chain = {
      zadd: (_key: string, score: number, member: string) => {
        ops.push(() => scores.set(member, score));
        return chain;
      },
      set: (key: string, value: string) => {
        ops.push(() => values.set(key, value));
        return chain;
      },
      zremrangebyscore: () => chain,
      zrem: (_key: string, member: string) => {
        ops.push(() => scores.delete(member));
        return chain;
      },
      del: (key: string) => {
        ops.push(() => values.delete(key));
        return chain;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
    return chain;
  };
  return {
    multi,
    zrangebyscore: async (_key: string, min: number) =>
      [...scores].filter(([, score]) => score >= min).map(([member]) => member),
    mget: async (keys: string[]) => keys.map((key) => values.get(key) ?? null),
  };
}

describe.skipIf(!available)('live: background jobs on a web replica (#256)', () => {
  let live: LiveDatabase;
  let admin: string;
  let organizationId: string;
  let stopWorker: () => Promise<void>;
  let stopListening: (() => Promise<void>) | null = null;
  const heard: unknown[] = [];
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin,
      role: 'admin',
      name: 'Admin',
      email: 'jobs-web@example.test',
      image: null,
      emailVerified: true,
      organizationId,
    });
    await next();
  });
  app.route('/lifecycle', lifecycleRoutes);

  const runAudits = async (job: string) =>
    live.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'job.run'), eq(schema.auditLog.targetId, job)));

  beforeAll(async () => {
    live = await createLiveDatabase('admin_jobs_web_role');
    state.db = live.db;
    state.url = live.connectionString;
    organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, organizationId, { role: 'admin' });
    state.redis = fakeRedis();
    // The worker: RUN_MIGRATIONS=false, so everything but the post-deploy job.
    const workerJobs = lifecycleJobs()
      .filter((job) => job.name !== POST_MIGRATIONS_JOB)
      .map(({ name, intervalMs }) => ({ name, intervalMs }));
    stopWorker = startReplicaHeartbeat('worker', workerJobs);
    // The heartbeat is written asynchronously on start.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  afterAll(async () => {
    await stopListening?.();
    await stopWorker?.();
    await live?.destroy();
  });

  it('lists what the worker runs, not the web replica’s own settings', async () => {
    // The web replica would schedule it itself, which is what was listed.
    expect(lifecycleJobs().map((job) => job.name)).toContain(POST_MIGRATIONS_JOB);
    const response = await app.request('/lifecycle/jobs');
    expect(response.status, await response.clone().text()).toBe(200);
    const { jobs } = (await response.json()) as { jobs: { name: string }[] };
    const names = jobs.map((job) => job.name);
    expect(names).not.toContain(POST_MIGRATIONS_JOB);
    expect(names).toContain('storage.recompute-usage');
  });

  it('refuses Run for a job no worker runs, saying why, and audits nothing', async () => {
    const response = await app.request(`/lifecycle/jobs/${POST_MIGRATIONS_JOB}/run`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'migrate --post',
    );
    expect(await runAudits(POST_MIGRATIONS_JOB)).toEqual([]);
  });

  it('refuses Run while the worker that checked in takes no requests, and audits nothing (#265)', async () => {
    // Its heartbeat is fresh, but it has stopped listening (stopped or crashed).
    manualRunAck.timeoutMs = 500;
    try {
      const response = await app.request('/lifecycle/jobs/storage.recompute-usage/run', {
        method: 'POST',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        'has not started',
      );
      expect(await runAudits('storage.recompute-usage')).toEqual([]);
    } finally {
      manualRunAck.timeoutMs = 5_000;
    }
  });

  it('still queues and audits a job the worker runs', async () => {
    // The worker listening, as a real one does: it takes the request.
    stopListening = await listenForJobRequests(async (request) => {
      heard.push(request);
    });
    const response = await app.request('/lifecycle/jobs/storage.recompute-usage/run', {
      method: 'POST',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ queued: true });
    expect(await runAudits('storage.recompute-usage')).toHaveLength(1);
    expect(heard).toEqual([{ job: 'storage.recompute-usage', requestId: expect.any(String) }]);
  });

  it('is still 404 for a job that exists nowhere', async () => {
    const response = await app.request('/lifecycle/jobs/no.such-job/run', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
