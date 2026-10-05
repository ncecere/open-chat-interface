import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Metrics behind the service objectives and alerts (v0.11 design, item 24;
 * docs/dev/slo.md): route labels name the handler that ran, reply start and
 * provider first output, readiness changes, job successes, interrupted
 * replies counted across replicas, and the operational gauges read at
 * scrape time.
 */
const state = vi.hoisted(() => ({
  redis: null as null | {
    incr: (key: string) => Promise<number>;
    get: (key: string) => Promise<string | null>;
    ping: () => Promise<string>;
  },
  configured: true,
  rows: {} as Record<string, unknown[]>,
  failing: new Set<string>(),
  env: {} as Record<string, unknown>,
}));

vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/chat-streams.js', () => ({
  sharedRedis: async () => state.redis,
  sharedRedisClient: async () => state.redis,
  redisConfigured: () => state.configured,
}));

/** The text of a Drizzle `sql` query, to answer it by what it reads. */
function queryText(query: { queryChunks?: Array<{ value?: string[] }> }): string {
  return (query.queryChunks ?? []).map((chunk) => chunk.value?.join('') ?? '').join('');
}
vi.mock('../../db/index.js', () => {
  const answer = async (query: never) => {
    const text = queryText(query);
    const key = ['pg_stat_activity', 'pg_stat_replication', 'conversation_import', 'select 1'].find(
      (name) => text.includes(name),
    );
    if (!key || state.failing.has(key)) throw new Error(`no answer for ${text}`);
    return state.rows[key] ?? [];
  };
  const failingSelect = () => {
    throw new Error('not in this test');
  };
  return { db: { execute: answer, select: failingSelect }, sql: answer };
});

const metrics = await import('../../services/observability/metrics.js');
const events = await import('../../services/observability/events.js');
const { observeRequests } = await import('../../services/observability/http.js');

beforeEach(() => {
  metrics.resetMetrics();
  events.resetReadinessForTests();
  state.redis = null;
  state.configured = true;
  state.failing.clear();
  state.env = {};
  state.rows = {
    'select 1': [{ '?column?': 1 }],
    pg_stat_activity: [
      { state: 'active', total: 3 },
      { state: 'idle', total: 5 },
    ],
    pg_stat_replication: [{ lag: 0.25 }],
    conversation_import: [{ imports: 2, compaction: 1, rollups: 40 }],
  };
});

describe('route labels', () => {
  /** Like the thread routes: an auth middleware, then `/search` registered before `/:id`. */
  function app() {
    const threads = new Hono();
    threads.use('*', async (c, next) => {
      if (!c.req.header('x-signed-in')) return c.json({ error: 'sign in' }, 401);
      await next();
    });
    threads.get('/', (c) => c.json([]));
    threads.get('/search', (c) => c.json({ results: [] }));
    threads.get('/:id', (c) => c.json({ id: c.req.param('id') }));
    threads.delete('/:id', (c) => c.body(null, 204));
    const api = new Hono();
    api.route('/threads', threads);
    const root = new Hono();
    root.use('*', observeRequests);
    root.route('/api', api);
    return root;
  }
  const signedIn = { headers: { 'x-signed-in': '1' } };
  const count = (method: string, route: string, status: number) =>
    metrics.httpRequests.get({ method, route, status: String(status) });

  it('labels the handler that answered, not the last route that matched', async () => {
    const root = app();
    expect((await root.request('/api/threads/search?q=x', signedIn)).status).toBe(200);
    expect((await root.request('/api/threads/1234', signedIn)).status).toBe(200);
    expect((await root.request('/api/threads', signedIn)).status).toBe(200);
    expect(
      (await root.request('/api/threads/1234', { ...signedIn, method: 'DELETE' })).status,
    ).toBe(204);
    expect(count('GET', '/api/threads/search', 200)).toBe(1);
    expect(count('GET', '/api/threads/:id', 200)).toBe(1);
    expect(count('GET', '/api/threads', 200)).toBe(1);
    expect(count('DELETE', '/api/threads/:id', 204)).toBe(1);
  });

  it('labels a request a middleware refused with the route it was for', async () => {
    const root = app();
    expect((await root.request('/api/threads/search')).status).toBe(401);
    expect((await root.request('/api/threads/abc')).status).toBe(401);
    expect(count('GET', '/api/threads/search', 401)).toBe(1);
    expect(count('GET', '/api/threads/:id', 401)).toBe(1);
  });

  it('groups requests no handler claimed as unmatched', async () => {
    const root = app();
    expect((await root.request('/api/threads/a/b/c', signedIn)).status).toBe(404);
    expect((await root.request('/elsewhere')).status).toBe(404);
    expect(count('GET', 'unmatched', 404)).toBe(2);
  });
});

describe('objective and alert metrics', () => {
  it('times the reply start added by OCI and the provider’s first output', async () => {
    events.observeReplyStart(400);
    events.observeReplyStart(1_200);
    events.observeReplyStart(-5);
    events.observeProviderFirstOutput('Stub', 'stub-model', 800);
    const body = await metrics.renderMetrics();
    expect(body).toContain('oci_chat_reply_start_seconds_bucket{le="0.5"} 2');
    expect(body).toContain('oci_chat_reply_start_seconds_bucket{le="1"} 2');
    expect(body).toContain('oci_chat_reply_start_seconds_count 3');
    expect(body).toContain(
      'oci_provider_first_output_seconds_bucket{provider="Stub",model="stub-model",le="1"} 1',
    );
  });

  it('counts readiness changes, not every probe', () => {
    for (const ready of [true, true, false, false, true, false]) events.observeReadiness(ready);
    expect(metrics.readinessTransitions.get({ to: 'not_ready' })).toBe(2);
    expect(metrics.readinessTransitions.get({ to: 'ready' })).toBe(1);
  });

  it('records when each job last succeeded', () => {
    events.observeJob('usage.fold-rollups', 'error', 5);
    expect(metrics.jobLastSuccess.get({ job: 'usage.fold-rollups' })).toBeUndefined();
    const before = Math.floor(Date.now() / 1000);
    events.observeJob('usage.fold-rollups', 'success', 5);
    expect(metrics.jobLastSuccess.get({ job: 'usage.fold-rollups' })).toBeGreaterThanOrEqual(
      before,
    );
    metrics.jobLastSuccess.set({ job: 'x' }, Number.NaN);
    expect(metrics.jobLastSuccess.get({ job: 'x' })).toBeUndefined();
  });

  it('counts replies interrupted by a drain here and, through Redis, across replicas', async () => {
    const { recordDrainInterruptedReply } = await import(
      '../../services/observability/interrupted.js'
    );
    let stored = 4;
    state.redis = {
      incr: async () => ++stored,
      get: async () => String(stored),
      ping: async () => 'PONG',
    };
    await recordDrainInterruptedReply();
    expect(metrics.drainInterruptedReplies.get()).toBe(1);
    expect(stored).toBe(5);
    const body = await metrics.renderMetrics();
    expect(body).toContain('# TYPE oci_cluster_drain_interrupted_replies_total counter');
    expect(body).toContain('oci_cluster_drain_interrupted_replies_total 5');
    expect(body).toContain('oci_drain_interrupted_replies_total 1');
    // Redis failing still counts the reply here.
    state.redis = {
      incr: async () => {
        throw new Error('down');
      },
      get: async () => null,
      ping: async () => {
        throw new Error('down');
      },
    };
    await recordDrainInterruptedReply();
    expect(metrics.drainInterruptedReplies.get()).toBe(2);
    expect(await metrics.renderMetrics()).toContain('oci_redis_up 0');
  });

  it('reads the operational gauges when scraped', async () => {
    state.env = { DATABASE_POOL_MAX: 12, OCI_ROLE: 'all' };
    state.redis = { incr: async () => 1, get: async () => null, ping: async () => 'PONG' };
    const body = await metrics.renderMetrics();
    expect(body).toContain('oci_process_role{role="all"} 1');
    expect(body).toContain('oci_draining 0');
    expect(body).toContain('oci_database_pool_max 12');
    expect(body).toMatch(/oci_database_probe_seconds \d/);
    expect(body).toContain('oci_database_connections{state="active"} 3');
    expect(body).toContain('oci_database_connections{state="idle"} 5');
    expect(body).toContain('oci_database_connections{state="idle in transaction"} 0');
    expect(body).toContain('oci_database_replication_lag_seconds 0.25');
    expect(body).toContain('oci_queue_depth{queue="conversation_imports"} 2');
    expect(body).toContain('oci_queue_depth{queue="compaction"} 1');
    expect(body).toContain('oci_queue_depth{queue="usage_rollup_changes"} 40');
    expect(body).toContain('oci_redis_up 1');
    // This replica runs jobs (role all), even with no heartbeat listed.
    expect(body).toContain('oci_background_workers_alive 1');
    expect(body).toContain('oci_cluster_drain_interrupted_replies_total 0');
  });

  it('leaves out what it cannot read', async () => {
    state.configured = false;
    state.failing = new Set(['pg_stat_activity', 'conversation_import', 'select 1']);
    state.rows.pg_stat_replication = [{ lag: null }];
    const body = await metrics.renderMetrics();
    expect(body).not.toMatch(/^oci_database_connections\{/m);
    expect(body).not.toMatch(/^oci_queue_depth\{/m);
    expect(body).not.toMatch(/^oci_database_probe_seconds /m);
    expect(body).not.toMatch(/^oci_database_replication_lag_seconds /m);
    expect(body).not.toMatch(/^oci_redis_up /m);
    expect(body).not.toMatch(/^oci_cluster_drain_interrupted_replies_total /m);
    expect(body).not.toMatch(/^oci_replicas\{/m);
  });
});
