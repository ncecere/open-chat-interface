import { and, count, desc, eq, inArray, schema } from '@oci/db';
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDelivery,
  WebhookEndpoint,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { encryptSecret, generateToken } from '../../lib/crypto.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { assertAllowedUrl, ConnectorNetworkError } from '../connectors/network.js';
import { getDefaultOrganizationId } from '../organization.js';

type EndpointRow = typeof schema.webhookEndpoint.$inferSelect;

/** A new signing secret. Shown to the administrator once, stored only encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${generateToken(32)}`;
}

/** Whether an audit action is selected: an exact name, or a `prefix.*` covering it. */
export function actionSelected(
  endpoint: { allActions: boolean; actions: string[] },
  action: string,
) {
  if (endpoint.allActions) return true;
  return endpoint.actions.some((pattern) =>
    pattern.endsWith('.*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action,
  );
}

/** Checks the URL against the same outbound rules deliveries use, before saving. */
function assertDeliverableUrl(url: string, allowPrivateNetwork: boolean): void {
  try {
    assertAllowedUrl(url, { allowPrivateNetwork });
  } catch (error) {
    if (error instanceof ConnectorNetworkError) throw validationFailed(error.message);
    throw error;
  }
}

let cache: { rows: EndpointRow[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

/**
 * Enabled endpoints, cached briefly: every audit event consults this, and
 * most instances have none. Changes here clear this process's cache at once;
 * other replicas pick them up within the TTL.
 */
export async function enabledEndpoints(): Promise<EndpointRow[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.rows;
  const rows = await db
    .select()
    .from(schema.webhookEndpoint)
    .where(eq(schema.webhookEndpoint.enabled, true));
  cache = { rows, expiresAt: Date.now() + CACHE_TTL_MS };
  return rows;
}

export function invalidateWebhookCache(): void {
  cache = null;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toView(row: EndpointRow, pendingDeliveries: number): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    actions: row.actions,
    allActions: row.allActions,
    enabled: row.enabled,
    allowPrivateNetwork: row.allowPrivateNetwork,
    secretRotatedAt: row.secretRotatedAt.toISOString(),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    lastError: row.lastError,
    pendingDeliveries,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function pendingCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ endpointId: schema.webhookDelivery.endpointId, total: count() })
    .from(schema.webhookDelivery)
    .where(
      and(
        inArray(schema.webhookDelivery.endpointId, ids),
        eq(schema.webhookDelivery.status, 'pending'),
      ),
    )
    .groupBy(schema.webhookDelivery.endpointId);
  return new Map(rows.map((row) => [row.endpointId, row.total]));
}

export async function listWebhooks(): Promise<WebhookEndpoint[]> {
  const rows = await db
    .select()
    .from(schema.webhookEndpoint)
    .orderBy(schema.webhookEndpoint.createdAt);
  const pending = await pendingCounts(rows.map((row) => row.id));
  return rows.map((row) => toView(row, pending.get(row.id) ?? 0));
}

export async function loadWebhookOrThrow(id: string): Promise<EndpointRow> {
  const [row] = await db
    .select()
    .from(schema.webhookEndpoint)
    .where(eq(schema.webhookEndpoint.id, id))
    .limit(1);
  if (!row) throw notFound('Webhook endpoint not found');
  return row;
}

export async function getWebhook(id: string): Promise<WebhookEndpoint> {
  const row = await loadWebhookOrThrow(id);
  const pending = await pendingCounts([row.id]);
  return toView(row, pending.get(row.id) ?? 0);
}

const uniqueActions = (actions: string[]) => [...new Set(actions)].sort();

export async function createWebhook(
  input: CreateWebhookInput,
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  assertDeliverableUrl(input.url, input.allowPrivateNetwork);
  const secret = generateWebhookSecret();
  const [row] = await db
    .insert(schema.webhookEndpoint)
    .values({
      organizationId: await getDefaultOrganizationId(),
      url: input.url,
      description: input.description,
      actions: uniqueActions(input.actions),
      allActions: input.allActions,
      enabled: input.enabled,
      allowPrivateNetwork: input.allowPrivateNetwork,
      encryptedSecret: encryptSecret(secret),
    })
    .returning();
  invalidateWebhookCache();
  return { endpoint: toView(row!, 0), secret };
}

/** Applies a partial change; returns the names of the fields that changed, for the audit entry. */
export async function updateWebhook(
  existing: EndpointRow,
  input: UpdateWebhookInput,
): Promise<string[]> {
  const next = {
    url: input.url ?? existing.url,
    description: input.description ?? existing.description,
    actions: input.actions ? uniqueActions(input.actions) : existing.actions,
    allActions: input.allActions ?? existing.allActions,
    enabled: input.enabled ?? existing.enabled,
    allowPrivateNetwork: input.allowPrivateNetwork ?? existing.allowPrivateNetwork,
  };
  if (!next.allActions && next.actions.length === 0)
    throw validationFailed('Choose at least one audit action, or all of them.');
  assertDeliverableUrl(next.url, next.allowPrivateNetwork);

  const fields = (Object.keys(next) as Array<keyof typeof next>).filter(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(existing[key]),
  );
  if (fields.length === 0) return [];
  await db
    .update(schema.webhookEndpoint)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(schema.webhookEndpoint.id, existing.id));
  invalidateWebhookCache();
  return fields;
}

/** Deletes the endpoint with its delivery log; returns how many deliveries were still pending. */
export async function deleteWebhook(existing: EndpointRow): Promise<{ pendingDropped: number }> {
  const pending = await pendingCounts([existing.id]);
  await db.delete(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.id, existing.id));
  invalidateWebhookCache();
  return { pendingDropped: pending.get(existing.id) ?? 0 };
}

/**
 * Replaces the signing secret. Deliveries from now on, including retries of
 * earlier events, are signed with the new one.
 */
export async function rotateWebhookSecret(existing: EndpointRow): Promise<string> {
  const secret = generateWebhookSecret();
  await db
    .update(schema.webhookEndpoint)
    .set({
      encryptedSecret: encryptSecret(secret),
      secretRotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.webhookEndpoint.id, existing.id));
  invalidateWebhookCache();
  return secret;
}

/** The delivery log of one endpoint, newest first. */
export async function listDeliveries(endpointId: string, limit = 50): Promise<WebhookDelivery[]> {
  const rows = await db
    .select()
    .from(schema.webhookDelivery)
    .where(eq(schema.webhookDelivery.endpointId, endpointId))
    .orderBy(desc(schema.webhookDelivery.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)));
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt.toISOString() : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    deliveredAt: iso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
  }));
}
