import { createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Read-only maintenance mode (v0.11 design, section 9) across two API
 * instances sharing PostgreSQL and Redis, each its own module graph (own
 * settings cache, own Redis connections and subscriber), through the real
 * /api routes: an administrator's switch on one replica refuses writes on the
 * other at once, and only the switch itself is allowed back; a scheduled
 * window is announced and applies by itself; jobs that write pause.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  connectionString: '',
  redisUrl: '',
  admin: { id: '', email: 'admin@example.test' },
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...original,
    loadEnv: () => ({
      ...original.loadEnv(),
      DATABASE_URL: state.connectionString,
      REDIS_URL: state.redisUrl,
    }),
  };
});

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
async function redisAvailable() {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = (await livePostgresAvailable()) && (await redisAvailable());

interface Instance {
  app: Hono<AppBindings>;
  settings: typeof import('../../services/settings.js');
  runner: typeof import('../../services/jobs/runner.js');
  jobs: typeof import('../../services/jobs/index.js');
  bus: typeof import('../../services/cache-bus/index.js');
  streams: typeof import('../../services/chat-streams.js');
  stop: () => Promise<void>;
}

/** One API replica: its own module graph, the real routes, signed in as the administrator. */
async function instance(): Promise<Instance> {
  vi.resetModules();
  const { createApiRoutes } = await import('../../routes/index.js');
  const { errorHandler } = await import('../../middleware/error-handler.js');
  const settings = await import('../../services/settings.js');
  const runner = await import('../../services/jobs/runner.js');
  const jobs = await import('../../services/jobs/index.js');
  const bus = await import('../../services/cache-bus/index.js');
  const streams = await import('../../services/chat-streams.js');
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: state.admin.id,
      email: state.admin.email,
      name: 'Admin',
      image: null,
      role: 'admin',
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api', createApiRoutes());
  const stop = await bus.startCacheBus();
  return { app, settings, runner, jobs, bus, streams, stop };
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

describe.skipIf(!available)('live read-only maintenance mode across replicas', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let a: Instance;
  let b: Instance;

  beforeAll(async () => {
    live = await createLiveDatabase('read_only');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.connectionString = live.connectionString;
    state.redisUrl = redisUrl;
    state.organizationId = await seedOrganization(pool.db);
    state.admin.id = await seedUser(pool.db, state.organizationId, {
      email: state.admin.email,
      role: 'admin',
    });
    a = await instance();
    b = await instance();
    await vi.waitFor(() => {
      expect(a.bus.cacheBusStatus()).toBe('listening');
      expect(b.bus.cacheBusStatus()).toBe('listening');
    });
  }, 30_000);
  afterEach(async () => {
    vi.useRealTimers();
    // Off again, through the switch, for the next test.
    await put(a, { readOnly: false, window: null });
    await pool.db
      .delete(schema.instanceSetting)
      .where(eq(schema.instanceSetting.key, 'maintenance'));
    a.settings.invalidateSettingsCache();
    b.settings.invalidateSettingsCache();
  });
  afterAll(async () => {
    for (const replica of [a, b]) {
      await replica?.stop();
      await replica?.streams.closeChatStreams();
    }
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const put = (replica: Instance, body: unknown) =>
    replica.app.request('/api/admin/maintenance', { method: 'PUT', ...json(body) });
  const createProject = (replica: Instance) =>
    replica.app.request('/api/projects', { method: 'POST', ...json({ name: 'During' }) });

  it('switches on from one replica and refuses writes on the other at once', async () => {
    // Both replicas have read (and cached) the setting: off.
    expect(await (await b.app.request('/api/maintenance')).json()).toMatchObject({ active: false });
    expect((await createProject(b)).status).toBe(201);

    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const switched = await put(a, { readOnly: true, reason: 'Database upgrade', until });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      readOnly: true,
      status: { active: true, source: 'administrator', reason: 'Database upgrade', until },
      changedBy: state.admin.email,
    });

    // B refuses without waiting for its cache to expire.
    const refused = await createProject(b);
    expect(refused.status).toBe(423);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(1_700);
    expect(await refused.json()).toMatchObject({
      error: { code: 'READ_ONLY', details: { readOnly: { active: true, until } } },
    });
    // Reading still works on both, and says why.
    expect((await b.app.request('/api/projects')).status).toBe(200);
    expect(await (await b.app.request('/api/maintenance')).json()).toMatchObject({
      active: true,
      reason: 'Database upgrade',
    });
    // Other settings changes are refused; the switch is not.
    expect(
      (await b.app.request('/api/admin/settings', { method: 'PATCH', ...json({}) })).status,
    ).toBe(423);

    // Turned off on B: A accepts writes again at once.
    expect((await put(b, { readOnly: false })).status).toBe(200);
    expect((await createProject(a)).status).toBe(201);

    // Audited: who, when, why.
    const entries = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'maintenance.read_only.update'));
    expect(entries.map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({
        active: { before: false, after: true },
        source: 'administrator',
        reason: 'Database upgrade',
        until,
      }),
      expect.objectContaining({ active: { before: true, after: false } }),
    ]);
    expect(entries[0]).toMatchObject({ actorEmail: state.admin.email });
    expect(entries[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('announces a scheduled window and applies it on every replica at its start', async () => {
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60_000);
    const response = await put(a, {
      window: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: 'Moving to the new cluster.',
      },
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { window: { announcementId: string } };
    // Announced now, until the window starts.
    const [announcement] = await pool.db
      .select()
      .from(schema.broadcast)
      .where(eq(schema.broadcast.id, view.window.announcementId));
    expect(announcement).toMatchObject({
      title: 'Scheduled maintenance',
      level: 'warning',
      published: true,
      startsAt: null,
      endsAt: startsAt,
    });
    expect(announcement?.body).toContain('read-only');
    expect(announcement?.body).toContain('Moving to the new cluster.');
    // With its end, so an open page hides it as the window starts (#160).
    expect(await (await b.app.request('/api/me/broadcasts')).json()).toMatchObject({
      broadcasts: [
        expect.objectContaining({
          title: 'Scheduled maintenance',
          endsAt: startsAt.toISOString(),
        }),
      ],
    });
    // Not yet read-only.
    expect((await createProject(b)).status).toBe(201);

    // At the start, both replicas refuse writes, with Retry-After to the end.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startsAt.getTime() + 1_000);
    for (const replica of [a, b]) {
      const refused = await createProject(replica);
      expect(refused.status).toBe(423);
      expect(refused.headers.get('x-oci-read-only')).toBe('schedule');
      expect(Number(refused.headers.get('retry-after'))).toBe(2 * 60 * 60 - 1);
    }
    // And end at its end, with nobody touching anything.
    vi.setSystemTime(endsAt.getTime() + 1_000);
    expect((await createProject(b)).status).toBe(201);
    vi.useRealTimers();

    // Cancelling the window removes its announcement.
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const rescheduled = (await (
      await put(a, { window: { startsAt: later, endsAt: endsAt.toISOString() } })
    ).json()) as { window: { announcementId: string } };
    expect(rescheduled.window.announcementId).toBe(view.window.announcementId);
    expect((await put(a, { window: null })).status).toBe(200);
    expect(
      await pool.db
        .select()
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, view.window.announcementId)),
    ).toEqual([]);
  });

  it('refuses invalid changes and unknown jobs', async () => {
    expect((await put(a, {})).status).toBe(422);
    expect((await put(a, { keepRunningJobs: ['no.such-job'] })).status).toBe(422);
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      (await put(a, { window: { startsAt: past, endsAt: new Date().toISOString() } })).status,
    ).toBe(422);
  });

  it('pauses jobs that write, keeps the chosen ones running, and stops a running one after its batch', async () => {
    const { runner, jobs } = a;
    expect((await put(b, { readOnly: true })).status).toBe(200);

    // A writing job does not start (on A, told by B).
    expect(await jobs.runJobNow('retention.share-links')).toBeNull();
    // A job kept running by default does.
    expect(await jobs.runJobNow('webhooks.deliver')).toBe(0);
    const ran = await pool.db.select({ job: schema.jobRun.jobName }).from(schema.jobRun);
    expect(ran.map((row) => row.job)).toEqual(['webhooks.deliver']);
    // "Run now" from System health is refused like any other write.
    const runNow = await b.app.request('/api/admin/lifecycle/jobs/retention.share-links/run', {
      method: 'POST',
    });
    expect(runNow.status).toBe(423);

    // The administrator chooses: retention keeps running, webhooks pause.
    expect((await put(b, { keepRunningJobs: ['retention.share-links'] })).status).toBe(200);
    expect(await jobs.runJobNow('retention.share-links')).toBe(0);
    expect(await jobs.runJobNow('webhooks.deliver')).toBeNull();
    const view = (await (await a.app.request('/api/admin/maintenance')).json()) as {
      jobs: Array<{ name: string; keepsRunning: boolean; defaultKeepsRunning: boolean }>;
    };
    expect(view.jobs.find((job) => job.name === 'webhooks.deliver')).toEqual({
      name: 'webhooks.deliver',
      keepsRunning: false,
      defaultKeepsRunning: true,
    });

    // Off: a long job starts; switched on mid-run, it stops after its batch.
    expect((await put(b, { readOnly: false, keepRunningJobs: [] })).status).toBe(200);
    const batches: number[] = [];
    const run = runner.runExclusively({
      name: 'imports.process',
      intervalMs: 60_000,
      run: async () => {
        for (let batch = 1; batch <= 200; batch++) {
          batches.push(batch);
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!(await runner.jobMayContinue())) break;
        }
        return batches.length;
      },
    });
    await vi.waitFor(() => expect(batches.length).toBeGreaterThanOrEqual(3));
    expect((await put(b, { readOnly: true })).status).toBe(200);
    const atSwitch = batches.length;
    // The batch in hand when B's switch reached A is finished, and no other.
    expect(await run).toBeLessThanOrEqual(atSwitch + 1);
  });
});
