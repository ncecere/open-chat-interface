import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { WebhookDelivery, WebhookEndpoint, WebhookWithSecret } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Webhooks end to end: real PostgreSQL, the real admin routes, audit hook,
 * delivery queue and outbound guard, against a receiver on 127.0.0.1
 * (reached only because the endpoint allows private networks).
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
// Deliveries are driven explicitly; the immediate kick would race the assertions.
vi.mock('../../services/jobs/index.js', () => ({ runJobNow: async () => null }));

const available = await livePostgresAvailable();

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

describe.skipIf(!available)('live: signed webhooks', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let auditor: string;
  let app: Hono<AppBindings>;
  let server: Server;
  let url: string;
  let received: Received[];
  let respondWith: number;
  let delivery: typeof import('../../services/webhooks/delivery.js');
  let signing: typeof import('../../services/webhooks/signing.js');
  let recordAudit: typeof import('../../services/audit.js').recordAudit;
  let invalidate: () => void;

  beforeAll(async () => {
    live = await createLiveDatabase('webhooks');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    auditor = await seedUser(pool.db, state.organizationId, { role: 'auditor' });

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(respondWith, { 'content-type': 'text/plain' });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/oci`;

    delivery = await import('../../services/webhooks/delivery.js');
    signing = await import('../../services/webhooks/signing.js');
    ({ recordAudit } = await import('../../services/audit.js'));
    ({ invalidateWebhookCache: invalidate } = await import('../../services/webhooks/endpoints.js'));
    const { adminRoutes } = await import('../../routes/admin/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      const id = c.req.header('x-test-user')!;
      const role = id === admin ? 'admin' : 'auditor';
      c.set('user', {
        id,
        name: 'Test',
        email: `${role}@example.test`,
        image: null,
        role,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/admin', adminRoutes);
  });

  beforeEach(() => {
    received = [];
    respondWith = 200;
  });
  afterEach(async () => {
    await pool.db.delete(schema.webhookEndpoint);
    invalidate();
  });
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function call(
    method: string,
    path: string,
    { user = admin, body }: { user?: string; body?: unknown } = {},
  ) {
    return app.request(path, {
      method,
      headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
    const resolved = await response;
    const text = await resolved.text();
    expect(resolved.status, text).toBe(status);
    return JSON.parse(text) as T;
  }
  async function create(body: Record<string, unknown> = {}) {
    return ok<WebhookWithSecret>(
      call('POST', '/api/admin/webhooks', {
        body: { url, actions: ['user.*', 'backup.run'], allowPrivateNetwork: true, ...body },
      }),
      201,
    );
  }
  const deliveries = (id: string) =>
    ok<{ deliveries: WebhookDelivery[] }>(
      call('GET', `/api/admin/webhooks/${id}/deliveries`, { user: auditor }),
    );

  it('shows the secret once, and lets auditors read but not change', async () => {
    const created = await create({ description: 'SIEM' });
    expect(created.secret).toMatch(/^whsec_/);
    const listed = await ok<{ webhooks: WebhookEndpoint[] }>(
      call('GET', '/api/admin/webhooks', { user: auditor }),
    );
    expect(listed.webhooks).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const [row] = await pool.db.select().from(schema.webhookEndpoint);
    expect(row!.encryptedSecret).not.toContain(created.secret);

    expect(
      (
        await call('POST', '/api/admin/webhooks', {
          user: auditor,
          body: { url, allActions: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('POST', `/api/admin/webhooks/${created.id}/rotate`, { user: auditor })).status,
    ).toBe(403);
    // At least one action, or all of them.
    expect((await call('POST', '/api/admin/webhooks', { body: { url, actions: [] } })).status).toBe(
      422,
    );
  });

  it('delivers selected audit events signed with HMAC-SHA256 over timestamp and body', async () => {
    const created = await create();
    await recordAudit({
      actorUserId: admin,
      actorEmail: 'admin@example.test',
      action: 'user.create',
      targetType: 'user',
      targetId: 'u-1',
      metadata: { role: 'user' },
      ipAddress: '203.0.113.9',
    });
    // Not selected: no delivery queued.
    await recordAudit({ action: 'provider.update', metadata: {} });
    expect(await delivery.processWebhookDeliveries()).toBe(1);

    expect(received).toHaveLength(1);
    const [request] = received;
    const timestamp = request!.headers['oci-webhook-timestamp'] as string;
    const signature = request!.headers['oci-webhook-signature'] as string;
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(
      signing.verifyWebhookSignature({
        secret: created.secret,
        signature,
        timestamp,
        body: request!.body,
      }),
    ).toBe(true);
    expect(
      signing.verifyWebhookSignature({
        secret: 'whsec_wrong',
        signature,
        timestamp,
        body: request!.body,
      }),
    ).toBe(false);
    expect(
      signing.verifyWebhookSignature({
        secret: created.secret,
        signature,
        timestamp,
        body: `${request!.body} `,
      }),
    ).toBe(false);
    expect(request!.headers['oci-webhook-event']).toBe('user.create');
    expect(request!.headers['content-type']).toBe('application/json');

    const payload = JSON.parse(request!.body);
    const [audit] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.create'));
    expect(payload).toEqual({
      id: audit!.id,
      type: 'user.create',
      createdAt: expect.any(String),
      actor: { id: admin, email: 'admin@example.test' },
      target: { type: 'user', id: 'u-1' },
      metadata: { role: 'user' },
    });
    expect(request!.body).not.toContain('203.0.113.9');
    expect(request!.headers['oci-webhook-id']).toBeTruthy();

    const log = await deliveries(created.id);
    expect(log.deliveries).toEqual([
      expect.objectContaining({
        event: 'user.create',
        status: 'succeeded',
        attempts: 1,
        lastStatusCode: 200,
      }),
    ]);
  });

  it('treats a delivery queued earlier in the same millisecond as due', async () => {
    // PostgreSQL keeps microseconds and JavaScript milliseconds, so on a fast
    // machine "now" can read as just before a delivery queued a moment ago.
    await create();
    await recordAudit({ action: 'backup.run', metadata: { status: 'succeeded' } });
    await pool.db.execute(
      sql`update webhook_delivery set next_attempt_at = '2026-10-03T12:00:00.123456Z'`,
    );
    const now = new Date('2026-10-03T12:00:00.123Z');
    expect(await delivery.processWebhookDeliveries({ now })).toBe(1);
  });

  it('retries a failing endpoint with growing delays and gives up after the last attempt', async () => {
    const created = await create();
    const original = delivery.WEBHOOK_LIMITS.maxAttempts;
    delivery.WEBHOOK_LIMITS.maxAttempts = 3;
    try {
      respondWith = 500;
      await recordAudit({ action: 'backup.run', metadata: { status: 'succeeded' } });
      let now = new Date();
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await delivery.processWebhookDeliveries({ now })).toBe(1);
        // Not due again before its delay has passed.
        expect(await delivery.processWebhookDeliveries({ now })).toBe(0);
        const [row] = await pool.db.select().from(schema.webhookDelivery);
        expect(row!.attempts).toBe(attempt);
        if (attempt < 3) {
          expect(row!.status).toBe('pending');
          delays.push(row!.nextAttemptAt.getTime() - now.getTime());
          now = new Date(row!.nextAttemptAt.getTime() + 1);
        } else {
          expect(row!.status).toBe('failed');
        }
      }
      expect(delays).toEqual([60_000, 120_000]);
      expect(received).toHaveLength(3);
      // Every retry is signed afresh over identical bytes.
      expect(new Set(received.map((request) => request.body)).size).toBe(1);

      const log = await deliveries(created.id);
      expect(log.deliveries[0]).toMatchObject({
        status: 'failed',
        attempts: 3,
        lastStatusCode: 500,
        lastError: 'The endpoint answered HTTP 500.',
        nextAttemptAt: null,
      });
      const endpoint = await ok<WebhookEndpoint>(call('GET', `/api/admin/webhooks/${created.id}`));
      expect(endpoint.lastError).toBe('The endpoint answered HTTP 500.');

      const { webhookHealthCheck } = await import('../../services/observability/health-checks.js');
      expect(await webhookHealthCheck()).toMatchObject({ status: 'warn' });
      const { webhookDeliveries } = await import('../../services/observability/metrics.js');
      expect(webhookDeliveries.get({ outcome: 'failed' })).toBeGreaterThanOrEqual(1);
      expect(webhookDeliveries.get({ outcome: 'retrying' })).toBeGreaterThanOrEqual(2);
    } finally {
      delivery.WEBHOOK_LIMITS.maxAttempts = original;
    }
  });

  it('refuses private and loopback targets unless the endpoint allows private networks', async () => {
    // A private IP literal is refused when saved.
    const refused = await call('POST', '/api/admin/webhooks', { body: { url, allActions: true } });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toMatch(/private/);

    // A name that resolves to loopback is refused when sent, without retrying.
    const created = await create({
      url: 'https://localhost:9/hook',
      allowPrivateNetwork: false,
      allActions: true,
    });
    await recordAudit({ action: 'user.update', metadata: {} });
    await delivery.processWebhookDeliveries();
    const [row] = await pool.db.select().from(schema.webhookDelivery);
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row!.lastError).toMatch(/private or reserved network/);
    expect(received).toHaveLength(0);

    // Turning off "allow private network" for a loopback address is refused too.
    const loopback = await create();
    const patch = await call('PATCH', `/api/admin/webhooks/${loopback.id}`, {
      body: { allowPrivateNetwork: false },
    });
    expect(patch.status).toBe(422);
    // Metadata addresses are refused even with private networks allowed.
    const metadata = await call('POST', '/api/admin/webhooks', {
      body: { url: 'http://169.254.169.254/latest', allActions: true, allowPrivateNetwork: true },
    });
    expect(metadata.status).toBe(422);
    expect(created.id).toBeTruthy();
  });

  it('sends a test event, rotates the secret, and audits every change', async () => {
    const created = await create();
    const test = await ok<{ ok: boolean; status: number }>(
      call('POST', `/api/admin/webhooks/${created.id}/test`),
    );
    expect(test).toMatchObject({ ok: true, status: 200 });
    expect(received[0]!.headers['oci-webhook-event']).toBe('webhook.test');

    const rotated = await ok<WebhookWithSecret>(
      call('POST', `/api/admin/webhooks/${created.id}/rotate`),
    );
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    await call('POST', `/api/admin/webhooks/${created.id}/test`);
    const last = received.at(-1)!;
    const check = (secret: string) =>
      signing.verifyWebhookSignature({
        secret,
        signature: last.headers['oci-webhook-signature'] as string,
        timestamp: last.headers['oci-webhook-timestamp'] as string,
        body: last.body,
      });
    expect(check(rotated.secret)).toBe(true);
    expect(check(created.secret)).toBe(false);

    const updated = await ok<WebhookEndpoint>(
      call('PATCH', `/api/admin/webhooks/${created.id}`, {
        body: { enabled: false, description: 'Paused' },
      }),
    );
    expect(updated).toMatchObject({ enabled: false, description: 'Paused' });
    // Disabled endpoints receive nothing.
    await recordAudit({ action: 'user.create', metadata: {} });
    const queued = await pool.db
      .select()
      .from(schema.webhookDelivery)
      .where(eq(schema.webhookDelivery.event, 'user.create'));
    expect(queued).toHaveLength(0);

    expect((await call('DELETE', `/api/admin/webhooks/${created.id}`)).status).toBe(200);
    const actions = (
      await pool.db
        .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.action} like 'webhook.%'`)
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'webhook.create',
        'webhook.rotate',
        'webhook.update',
        'webhook.delete',
      ]),
    );
    const audits = JSON.stringify(await pool.db.select().from(schema.auditLog));
    expect(audits).not.toContain(rotated.secret);
    expect(audits).not.toContain(created.secret);
    expect((await call('GET', `/api/admin/webhooks/${created.id}`)).status).toBe(404);
  });

  it("records a test's outcome on the endpoint, as any delivery does (#144)", async () => {
    const created = await create();
    expect(created.lastSuccessAt).toBeNull();
    await ok(call('POST', `/api/admin/webhooks/${created.id}/test`));
    const delivered = await ok<WebhookEndpoint>(call('GET', `/api/admin/webhooks/${created.id}`));
    expect(delivered.lastSuccessAt).not.toBeNull();
    expect(delivered.lastFailureAt).toBeNull();

    respondWith = 500;
    await ok(call('POST', `/api/admin/webhooks/${created.id}/test`));
    const failed = await ok<WebhookEndpoint>(call('GET', `/api/admin/webhooks/${created.id}`));
    expect(failed.lastSuccessAt).toBe(delivered.lastSuccessAt);
    expect(failed.lastFailureAt).not.toBeNull();
    expect(failed.lastError).toContain('500');
  });

  it('leases claimed rows, so a delivery is not sent twice by overlapping runs', async () => {
    await create({ allActions: true });
    await recordAudit({ action: 'report.run', metadata: {} });
    // All actions: its own webhook.create entry is queued too.
    const queued = (await pool.db.select().from(schema.webhookDelivery)).length;
    expect(queued).toBe(2);
    const [first, second] = await Promise.all([
      delivery.processWebhookDeliveries(),
      delivery.processWebhookDeliveries(),
    ]);
    expect(first + second).toBe(queued);
    expect(received).toHaveLength(queued);
    expect(new Set(received.map((request) => request.headers['oci-webhook-id'])).size).toBe(queued);
    // Finished deliveries older than the log's retention are pruned.
    await pool.db
      .update(schema.webhookDelivery)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) });
    await delivery.processWebhookDeliveries();
    expect(await pool.db.select().from(schema.webhookDelivery)).toHaveLength(0);
  });
});
