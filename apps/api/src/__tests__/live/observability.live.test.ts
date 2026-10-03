import { createDatabase, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * `/metrics`: off without a token, Bearer-protected with one, and exposing
 * route templates, job, tool, reply, webhook and backup metrics, with queue
 * depths read from a real database.
 */
const state = vi.hoisted(() => ({ db: null as unknown, env: {} as Record<string, unknown> }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const available = await livePostgresAvailable();
const TOKEN = 'metrics-token-for-tests-0123456789';

describe.skipIf(!available)('live: Prometheus metrics endpoint', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono;
  let metrics: typeof import('../../services/observability/metrics.js');

  beforeAll(async () => {
    live = await createLiveDatabase('metrics');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    const organizationId = await seedOrganization(pool.db);
    const finishedAt = new Date('2026-10-01T03:05:00Z');
    await pool.db.insert(schema.backupRun).values({
      organizationId,
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: finishedAt,
      finishedAt,
      destination: 'storage',
      keyPrefix: '.oci-backups/',
    });

    const { metricsRoutes, observeRequests } = await import('../../services/observability/http.js');
    metrics = await import('../../services/observability/metrics.js');
    app = new Hono();
    app.use('*', observeRequests);
    app.route('/metrics', metricsRoutes);
    app.get('/api/threads/:id', (c) => c.json({ id: c.req.param('id') }));
    app.get('/api/fail', () => {
      throw new Error('boom');
    });
    app.onError((_, c) => c.json({ error: 'x' }, 500));
  });
  beforeEach(() => {
    metrics.resetMetrics();
    state.env = { METRICS_TOKEN: TOKEN };
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const scrape = (token?: string) =>
    app.request('/metrics', token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it('is not served without a configured token', async () => {
    state.env = { METRICS_TOKEN: undefined };
    expect((await scrape(TOKEN)).status).toBe(404);
  });

  it('requires the token as a Bearer credential', async () => {
    const missing = await scrape();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await scrape('wrong-token-wrong-token-wrong')).status).toBe(401);
    expect((await app.request('/metrics', { headers: { authorization: TOKEN } })).status).toBe(401);
    const ok = await scrape(TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
  });

  it('labels requests by route template, never by raw path, and counts the rest', async () => {
    await app.request('/api/threads/7f3c2a9e-secret-thread-id');
    await app.request('/api/threads/another-id');
    await app.request('/api/fail');
    await app.request('/nowhere/at/all');

    const { observeChatReply, observeJob, observeToolCall } = await import(
      '../../services/observability/events.js'
    );
    observeChatReply('complete', Date.now() - 1500);
    observeChatReply('weird-status', Date.now());
    observeToolCall('mcp__docs__search', 'ok', 120);
    observeToolCall('a tool with spaces and "quotes"', 'denied', null);
    observeJob('webhooks.deliver', 'success', 40);
    metrics.webhookDeliveries.inc({ outcome: 'retrying' });
    metrics.backupRuns.inc({ outcome: 'succeeded' });

    const body = await (await scrape(TOKEN)).text();
    expect(body).toContain(
      'oci_http_requests_total{method="GET",route="/api/threads/:id",status="200"} 2',
    );
    expect(body).toContain(
      'oci_http_requests_total{method="GET",route="/api/fail",status="500"} 1',
    );
    expect(body).toContain(
      'oci_http_requests_total{method="GET",route="unmatched",status="404"} 1',
    );
    expect(body).not.toContain('7f3c2a9e');
    expect(body).toContain(
      'oci_http_request_duration_seconds_bucket{method="GET",route="/api/threads/:id",le="+Inf"} 2',
    );
    expect(body).toContain('oci_chat_replies_total{status="complete"} 1');
    expect(body).toContain('oci_chat_replies_total{status="other"} 1');
    expect(body).toContain('oci_chat_reply_duration_seconds_count{status="complete"} 1');
    expect(body).toContain('oci_tool_calls_total{tool="mcp__docs__search",outcome="ok"} 1');
    expect(body).toContain('oci_tool_calls_total{tool="other",outcome="denied"} 1');
    expect(body).toContain('oci_job_runs_total{job="webhooks.deliver",outcome="success"} 1');
    expect(body).toContain('oci_webhook_deliveries_total{outcome="retrying"} 1');
    expect(body).toContain('oci_backup_runs_total{outcome="succeeded"} 1');
    // Read from the database at scrape time.
    expect(body).toContain('oci_webhook_deliveries_pending 0');
    expect(body).toContain('oci_storage_deletions_pending 0');
    expect(body).toContain(
      `oci_backup_last_success_timestamp_seconds ${Date.UTC(2026, 9, 1, 3, 5) / 1000}`,
    );
    expect(body).toMatch(/oci_build_info\{version="[^"]+"\} 1/);
    expect(body).toMatch(/process_resident_memory_bytes \d+/);
    // Well-formed exposition: every sample line is "name{labels} value".
    for (const line of body.trim().split('\n'))
      expect(line).toMatch(/^(# (HELP|TYPE) \S+ .+|[a-z_]+(\{.*\})? [-+0-9.eInfNa]+)$/);
  });

  it('escapes label values and leaves out a gauge whose source fails', async () => {
    const counter = new metrics.Counter('test_total', 'Test.', ['name']);
    counter.inc({ name: 'a"b\\c\nd' });
    counter.inc({ name: 'x' }, -1);
    expect(counter.render()).toContain('test_total{name="a\\"b\\\\c\\nd"} 1');
    expect(counter.get({ name: 'x' })).toBe(0);
    const gauge = new metrics.CollectedGauge('test_gauge', 'Test.', [], async () => {
      throw new Error('database down');
    });
    expect(await gauge.render()).toBe('# HELP test_gauge Test.\n# TYPE test_gauge gauge');
    const histogram = new metrics.Histogram('test_seconds', 'Test.', [], [1]);
    histogram.observe({}, Number.NaN);
    histogram.observe({}, 0.5);
    expect(histogram.render()).toContain('test_seconds_bucket{le="1"} 1');
  });
});
