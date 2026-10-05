import { randomUUID } from 'node:crypto';
import { eq, inArray, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { createGuardedFetch, findNetworkError } from '../connectors/network.js';
import { kickJob } from '../jobs/requests.js';
import { webhookDeliveries } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { actionSelected, enabledEndpoints } from './endpoints.js';
import {
  EVENT_HEADER,
  ID_HEADER,
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
} from './signing.js';

/**
 * Webhook delivery: a durable queue in `webhook_delivery`, filled when an
 * audit event is recorded and drained by the `webhooks.deliver` job.
 *
 * At-least-once: a row is leased before sending, so a crash mid-delivery
 * retries it later; receivers deduplicate by the payload `id` (the audit
 * entry). Requests go through the connectors' outbound guard: HTTPS only,
 * no private, loopback or metadata addresses (unless the endpoint allows
 * private networks), no redirects, bounded response size and time.
 */

export const WEBHOOK_LIMITS = {
  /** Attempts before a delivery is marked failed. */
  maxAttempts: 8,
  /** First retry delay; doubles each attempt up to `maxDelayMs`. */
  baseDelayMs: 60_000,
  maxDelayMs: 60 * 60_000,
  /** Total time allowed for one request. */
  timeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
  /** How long a claimed row is hidden from other runs while it is being sent. */
  leaseMs: 5 * 60_000,
  /** Deliveries sent per job run. */
  batchSize: 50,
  /** Finished deliveries kept in the log. */
  logRetentionDays: 30,
};

/** Delay before the next attempt after `attempts` failed ones. */
export function retryDelayMs(attempts: number): number {
  return Math.min(
    WEBHOOK_LIMITS.baseDelayMs * 2 ** Math.max(0, attempts - 1),
    WEBHOOK_LIMITS.maxDelayMs,
  );
}

interface AuditEntry {
  id: string;
  action: string;
  createdAt: Date;
  actorUserId: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * The event payload: the audit entry's metadata, exactly what the audit log
 * shows. Audit entries never hold conversation content, and neither does
 * this; the IP address is left out.
 */
export function webhookPayload(entry: AuditEntry): string {
  return JSON.stringify({
    id: entry.id,
    type: entry.action,
    createdAt: entry.createdAt.toISOString(),
    actor:
      entry.actorUserId || entry.actorEmail
        ? { id: entry.actorUserId, email: entry.actorEmail }
        : null,
    target:
      entry.targetType || entry.targetId ? { type: entry.targetType, id: entry.targetId } : null,
    metadata: entry.metadata ?? {},
  });
}

let kickTimer: NodeJS.Timeout | null = null;

/**
 * Sends soon rather than at the next tick; collapses bursts into one run. On
 * a `web` replica a worker is asked to send instead (jobs/requests.ts).
 */
function scheduleWebhookDelivery(): void {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    kickJob('webhooks.deliver', () =>
      import('../jobs/index.js')
        .then(({ runJobNow }) => runJobNow('webhooks.deliver'))
        .catch((error: unknown) => {
          logger.warn({ err: String(error) }, 'Could not start webhook delivery immediately');
        }),
    );
  }, 1_000);
  kickTimer.unref();
}

/**
 * Queues deliveries for audit entries written inside a transaction (deletion
 * events, `services/compliance/deletions.ts`), in that transaction: a
 * rolled-back entry queues nothing, and a failure here fails the transaction
 * rather than leaving an entry its webhooks never hear about.
 */
export async function enqueueWebhookEventsIn(
  tx: Pick<typeof db, 'insert' | 'select'>,
  entries: AuditEntry[],
): Promise<number> {
  // Read through the transaction, not the cache's own connection, which a
  // transaction holding the last pooled connection would wait on forever.
  const endpoints = await tx
    .select()
    .from(schema.webhookEndpoint)
    .where(eq(schema.webhookEndpoint.enabled, true));
  if (endpoints.length === 0) return 0;
  const rows = entries.flatMap((entry) => {
    const selected = endpoints.filter((endpoint) => actionSelected(endpoint, entry.action));
    if (selected.length === 0) return [];
    const body = webhookPayload(entry);
    return selected.map((endpoint) => ({
      endpointId: endpoint.id,
      auditLogId: entry.id,
      event: entry.action,
      body,
      maxAttempts: WEBHOOK_LIMITS.maxAttempts,
    }));
  });
  if (rows.length === 0) return 0;
  await tx.insert(schema.webhookDelivery).values(rows);
  scheduleWebhookDelivery();
  return rows.length;
}

/**
 * Queues one delivery per enabled endpoint that selected this action. Called
 * by `recordAudit` after the entry is written; never throws.
 */
export async function enqueueWebhookEvent(entry: AuditEntry): Promise<number> {
  try {
    const endpoints = (await enabledEndpoints()).filter((endpoint) =>
      actionSelected(endpoint, entry.action),
    );
    if (endpoints.length === 0) return 0;
    const body = webhookPayload(entry);
    await db.insert(schema.webhookDelivery).values(
      endpoints.map((endpoint) => ({
        endpointId: endpoint.id,
        auditLogId: entry.id,
        event: entry.action,
        body,
        maxAttempts: WEBHOOK_LIMITS.maxAttempts,
      })),
    );
    scheduleWebhookDelivery();
    return endpoints.length;
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), action: entry.action },
      'Failed to queue webhook deliveries',
    );
    return 0;
  }
}

type AttemptResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; permanent: boolean };

/** Errors that will not fix themselves by retrying: the address or URL is refused. */
const PERMANENT_REASONS = new Set(['protocol', 'address', 'redirect']);

/** One signed POST. Exported for the test-delivery button. */
async function sendWebhook(
  endpoint: { url: string; allowPrivateNetwork: boolean; encryptedSecret: string },
  delivery: { id: string; event: string; body: string },
): Promise<AttemptResult> {
  let secret: string;
  try {
    secret = decryptSecret(endpoint.encryptedSecret);
  } catch {
    return {
      ok: false,
      status: null,
      error: 'The signing secret could not be decrypted.',
      permanent: true,
    };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const guardedFetch = createGuardedFetch({
    allowPrivateNetwork: endpoint.allowPrivateNetwork,
    maxResponseBytes: WEBHOOK_LIMITS.maxResponseBytes,
    idleTimeoutMs: WEBHOOK_LIMITS.timeoutMs,
  });
  return withSpan('webhook.deliver', { 'oci.webhook.event': delivery.event }, async (span) => {
    try {
      const response = await guardedFetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `OCI-Webhooks/${APP_VERSION}`,
          [ID_HEADER]: delivery.id,
          [EVENT_HEADER]: delivery.event,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, delivery.body),
        },
        body: delivery.body,
        signal: AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs),
      });
      // The body is not used; reading it lets the connection close cleanly.
      await response.arrayBuffer().catch(() => undefined);
      span.setAttributes({ 'http.response.status_code': response.status });
      if (response.status >= 200 && response.status < 300)
        return { ok: true, status: response.status };
      span.fail(`HTTP ${response.status}`);
      return {
        ok: false,
        status: response.status,
        error: `The endpoint answered HTTP ${response.status}.`,
        permanent: false,
      };
    } catch (error) {
      const refused = findNetworkError(error);
      span.fail(refused?.reason ?? 'network');
      if (refused)
        return {
          ok: false,
          status: null,
          error: refused.message,
          permanent: PERMANENT_REASONS.has(refused.reason),
        };
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        ok: false,
        status: null,
        error: timedOut
          ? 'The endpoint did not respond in time.'
          : 'The endpoint could not be reached.',
        permanent: false,
      };
    }
  });
}

type DeliveryRow = typeof schema.webhookDelivery.$inferSelect;

/** Leases due rows so a concurrent or crashed run cannot send them twice at once. */
async function claimDue(now: Date, limit: number): Promise<DeliveryRow[]> {
  const leaseUntil = new Date(now.getTime() + WEBHOOK_LIMITS.leaseMs);
  // `now` has millisecond precision and PostgreSQL microsecond: a delivery
  // queued earlier in the same millisecond (12:00:00.123456) is due at
  // 12:00:00.123, so compare against the end of that millisecond.
  const dueBefore = new Date(now.getTime() + 1);
  return db.execute<DeliveryRow>(sql`
    update ${schema.webhookDelivery}
    set next_attempt_at = ${leaseUntil.toISOString()}::timestamptz
    where id in (
      select id from ${schema.webhookDelivery}
      where status = 'pending' and next_attempt_at < ${dueBefore.toISOString()}::timestamptz
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, endpoint_id as "endpointId", event, body, attempts, max_attempts as "maxAttempts"
  `) as unknown as Promise<DeliveryRow[]>;
}

/**
 * Sends every due delivery (one batch). Run by the job runner; `now` lets
 * tests make retries due without waiting.
 */
export async function processWebhookDeliveries(options?: {
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const due = await claimDue(now, options?.limit ?? WEBHOOK_LIMITS.batchSize);
  if (due.length === 0) {
    await pruneDeliveryLog(now);
    return 0;
  }

  const endpointIds = [...new Set(due.map((row) => row.endpointId))];
  const endpoints = new Map(
    (
      await db
        .select()
        .from(schema.webhookEndpoint)
        .where(inArray(schema.webhookEndpoint.id, endpointIds))
    ).map((row) => [row.id, row]),
  );

  for (const row of due) {
    const endpoint = endpoints.get(row.endpointId);
    const attempts = row.attempts + 1;
    const attemptedAt = new Date();
    if (!endpoint?.enabled) {
      await db
        .update(schema.webhookDelivery)
        .set({
          status: 'failed',
          lastError: 'The endpoint is disabled.',
          lastAttemptAt: attemptedAt,
        })
        .where(eq(schema.webhookDelivery.id, row.id));
      webhookDeliveries.inc({ outcome: 'failed' });
      continue;
    }

    const result = await sendWebhook(endpoint, row);
    if (result.ok) {
      await db
        .update(schema.webhookDelivery)
        .set({
          status: 'succeeded',
          attempts,
          lastAttemptAt: attemptedAt,
          lastStatusCode: result.status,
          lastError: null,
          deliveredAt: attemptedAt,
        })
        .where(eq(schema.webhookDelivery.id, row.id));
      await db
        .update(schema.webhookEndpoint)
        .set({ lastSuccessAt: attemptedAt })
        .where(eq(schema.webhookEndpoint.id, endpoint.id));
      webhookDeliveries.inc({ outcome: 'succeeded' });
      continue;
    }

    const giveUp = result.permanent || attempts >= row.maxAttempts;
    await db
      .update(schema.webhookDelivery)
      .set({
        status: giveUp ? 'failed' : 'pending',
        attempts,
        lastAttemptAt: attemptedAt,
        lastStatusCode: result.status,
        lastError: result.error,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      })
      .where(eq(schema.webhookDelivery.id, row.id));
    await db
      .update(schema.webhookEndpoint)
      .set({ lastFailureAt: attemptedAt, lastError: result.error })
      .where(eq(schema.webhookEndpoint.id, endpoint.id));
    webhookDeliveries.inc({ outcome: giveUp ? 'failed' : 'retrying' });
  }
  await pruneDeliveryLog(now);
  return due.length;
}

/** Drops finished deliveries past the log's retention, a bounded batch at a time. */
async function pruneDeliveryLog(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - WEBHOOK_LIMITS.logRetentionDays * 24 * 60 * 60_000);
  await db.execute(sql`
    delete from ${schema.webhookDelivery}
    where id in (
      select id from ${schema.webhookDelivery}
      where status <> 'pending' and created_at < ${cutoff.toISOString()}::timestamptz
      limit 1000
    )
  `);
}

/**
 * The test button: sends a `webhook.test` event now, once, and records it in
 * the delivery log. Not retried.
 */
export async function sendTestDelivery(
  endpoint: typeof schema.webhookEndpoint.$inferSelect,
  actor: { id: string; email: string },
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const id = randomUUID();
  const body = webhookPayload({
    id,
    action: 'webhook.test',
    createdAt: new Date(),
    actorUserId: actor.id,
    actorEmail: actor.email,
    targetType: 'webhook',
    targetId: endpoint.id,
    metadata: { test: true },
  });
  const result = await sendWebhook(endpoint, { id, event: 'webhook.test', body });
  const attemptedAt = new Date();
  await db.insert(schema.webhookDelivery).values({
    id,
    endpointId: endpoint.id,
    event: 'webhook.test',
    body,
    status: result.ok ? 'succeeded' : 'failed',
    attempts: 1,
    maxAttempts: 1,
    nextAttemptAt: attemptedAt,
    lastAttemptAt: attemptedAt,
    lastStatusCode: result.status,
    lastError: result.ok ? null : result.error,
    deliveredAt: result.ok ? attemptedAt : null,
  });
  webhookDeliveries.inc({ outcome: result.ok ? 'succeeded' : 'failed' });
  return { ok: result.ok, status: result.status, error: result.ok ? null : result.error };
}

/** Pending deliveries, and how many are overdue, for System health and metrics. */
export async function webhookQueueStats(
  now = new Date(),
): Promise<{ pending: number; overdue: number }> {
  const overdueBefore = new Date(now.getTime() - 15 * 60_000);
  const [row] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${schema.webhookDelivery.nextAttemptAt} < ${overdueBefore.toISOString()}::timestamptz)::int`,
    })
    .from(schema.webhookDelivery)
    .where(eq(schema.webhookDelivery.status, 'pending'));
  return { pending: row?.pending ?? 0, overdue: row?.overdue ?? 0 };
}
