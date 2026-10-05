import { createDatabase } from '@oci/db';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * Cross-replica cache invalidation (v0.11 design, item 20). Two API instances
 * share PostgreSQL and Redis: each is its own module graph (vi.resetModules),
 * so each has its own settings cache, its own Redis connections and its own
 * subscriber, as two processes do. Reproduced first: on the previous code a
 * change made on A was read stale on B for up to 30 s.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  redisUrl: '',
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
    loadEnv: () => ({ ...original.loadEnv(), REDIS_URL: state.redisUrl }),
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
  settings: typeof import('../../services/settings.js');
  webhooks: typeof import('../../services/webhooks/endpoints.js');
  bus: typeof import('../../services/cache-bus/index.js');
  streams: typeof import('../../services/chat-streams.js');
  stop: () => Promise<void>;
}

/** One API replica: a fresh module graph with its own caches and Redis connections. */
async function instance(): Promise<Instance> {
  vi.resetModules();
  const settings = await import('../../services/settings.js');
  const webhooks = await import('../../services/webhooks/endpoints.js');
  const bus = await import('../../services/cache-bus/index.js');
  const streams = await import('../../services/chat-streams.js');
  const stop = await bus.startCacheBus();
  return { settings, webhooks, bus, streams, stop };
}

describe.skipIf(!available)('live cross-replica cache invalidation', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const instances: Instance[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('cache_bus');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const replica of instances.splice(0)) {
      await replica.stop();
      await replica.streams.closeChatStreams();
    }
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function pair() {
    const a = await instance();
    const b = await instance();
    instances.push(a, b);
    // Both subscribed before anything changes.
    await vi.waitFor(() => {
      expect(a.bus.cacheBusStatus()).toBe('listening');
      expect(b.bus.cacheBusStatus()).toBe('listening');
    });
    return { a, b };
  }

  it('applies a setting changed on one replica on the other at once', async () => {
    state.redisUrl = redisUrl;
    const { a, b } = await pair();
    await a.settings.updateSetting('features', { webSearch: false, memory: false });
    // B reads (and caches) the current value.
    expect((await b.settings.getSetting('features')).webSearch).toBe(false);

    const changedAt = Date.now();
    await a.settings.updateSetting('features', { webSearch: true });
    await vi.waitFor(
      async () => expect((await b.settings.getSetting('features')).webSearch).toBe(true),
      { timeout: 2_000, interval: 5 },
    );
    // Well inside the 30 s the cache used to keep a value.
    expect(Date.now() - changedAt).toBeLessThan(2_000);

    // Every key goes through the same path: a role's features, rate limits,
    // the read-only switch.
    await b.settings.getSetting('rateLimits');
    await a.settings.updateSetting('rateLimits', { authAttemptsPerMinute: 7 });
    await vi.waitFor(
      async () => expect((await b.settings.getSetting('rateLimits')).authAttemptsPerMinute).toBe(7),
      { timeout: 2_000, interval: 5 },
    );
  });

  it('applies a change made by another cache owner (webhook endpoints) on the other replica', async () => {
    state.redisUrl = redisUrl;
    const { a, b } = await pair();
    expect(await b.webhooks.enabledEndpoints()).toEqual([]);
    await pool.sql`
      insert into webhook_endpoint (organization_id, url, encrypted_secret, all_actions, enabled)
      values (${state.organizationId}, 'https://hooks.example.test/a', 'x', true, true)
    `;
    a.webhooks.invalidateWebhookCache();
    await vi.waitFor(async () => expect(await b.webhooks.enabledEndpoints()).toHaveLength(1), {
      timeout: 2_000,
      interval: 5,
    });
  });

  it('falls back to the 30 s expiry when Redis is unavailable', async () => {
    // Nothing listens on port 1: both replicas run without Redis.
    state.redisUrl = 'redis://127.0.0.1:1';
    const a = await instance();
    const b = await instance();
    instances.push(a, b);
    expect(b.bus.cacheBusStatus()).not.toBe('listening');

    await a.settings.updateSetting('features', { webSearch: false });
    expect((await b.settings.getSetting('features')).webSearch).toBe(false);
    await a.settings.updateSetting('features', { webSearch: true });
    // Stale on B: nothing told it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await b.settings.getSetting('features')).webSearch).toBe(false);

    // Fresh once the cached value expires.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await b.settings.getSetting('features')).webSearch).toBe(true);
  });
});
