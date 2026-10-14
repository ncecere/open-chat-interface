import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * RUN_POST_MIGRATIONS=auto (#385): a replica that does not migrate itself, such
 * as the worker of a chart installed with `migrations.enabled: false`, applies
 * post-deploy steps by itself, but only once every replica that heartbeats
 * runs this release. A step may enable what the previous release cannot read,
 * so it must not run while a replica of the previous release still serves.
 */
const state = vi.hoisted(() => ({ sql: null as unknown, env: {} as Record<string, unknown> }));
vi.mock('../../db/index.js', () => ({
  get sql() {
    return state.sql;
  },
  get db() {
    return null;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return { ...original, loadEnv: () => ({ ...original.loadEnv(), ...state.env }) };
});

const available = await livePostgresAvailable();
const jobs = await import('../../services/migrations/jobs.js');
const { APP_VERSION } = await import('../../version.js');

const replicas =
  (...versions: string[]) =>
  async () =>
    versions.map((version, index) => ({ id: `r${index}`, version })) as never;

describe.skipIf(!available)(
  'live PostgreSQL: post-deploy steps applied when every replica is current',
  () => {
    let live: LiveDatabase;
    let client: postgres.Sql;

    const finished = async () => {
      const [row] = await client<{ count: number }[]>`
      select count(*)::integer as count from oci_post_migration where finished_at is not null`;
      return row!.count;
    };

    beforeAll(async () => {
      live = await createLiveDatabase('post_migrations_auto');
      client = postgres(live.connectionString, { max: 2, prepare: false, onnotice: () => {} });
      state.sql = client;
      state.env = {
        DATABASE_URL: live.connectionString,
        RUN_MIGRATIONS: false,
        RUN_POST_MIGRATIONS: 'auto',
      };
    });
    afterAll(async () => {
      await client?.end({ timeout: 1 });
      await live?.destroy();
    });

    it('registers the post-deploy job on a replica that does not migrate itself', () => {
      expect(jobs.migrationJobs().map((job) => job.name)).toContain('migrations.post-deploy');
    });

    it('waits while a replica of the previous release still serves', async () => {
      expect(await jobs.applyPostMigrationsIfDue(replicas(APP_VERSION, '0.0.1'))).toBe(0);
      expect(await finished()).toBe(0);
    });

    it('waits when it cannot tell (no Redis, or nobody heartbeating)', async () => {
      expect(await jobs.applyPostMigrationsIfDue(async () => null)).toBe(0);
      expect(await jobs.applyPostMigrationsIfDue(replicas())).toBe(0);
      expect(await finished()).toBe(0);
    });

    it('applies the steps and schedules the background migrations once every replica is current', async () => {
      expect(
        await jobs.applyPostMigrationsIfDue(replicas(APP_VERSION, APP_VERSION, APP_VERSION)),
      ).toBeGreaterThan(0);
      expect(await finished()).toBeGreaterThan(0);
      const [row] = await client<{ count: number }[]>`
      select count(*)::integer as count from background_migration`;
      expect(row!.count).toBeGreaterThan(0);
      // Nothing left: the next run does nothing, even with the previous release back.
      expect(await jobs.applyPostMigrationsIfDue(replicas(APP_VERSION))).toBe(0);
    });

    it('a replica that sets RUN_POST_MIGRATIONS=true does not wait for the others', async () => {
      await client`delete from oci_post_migration`;
      state.env = { ...state.env, RUN_POST_MIGRATIONS: true };
      expect(await jobs.applyPostMigrationsIfDue(replicas('0.0.1'))).toBeGreaterThan(0);
    });
  },
);
