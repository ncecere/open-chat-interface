import { createWebhookSchema, updateWebhookSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { diffUpdate } from '../../services/settings-diff.js';
import { sendTestDelivery } from '../../services/webhooks/delivery.js';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  loadWebhookOrThrow,
  rotateWebhookSecret,
  updateWebhook,
} from '../../services/webhooks/endpoints.js';

/**
 * Tools & integrations → Webhooks. Secrets are returned once, when created
 * or rotated, and never again. Auditors may read, not change.
 */
export const webhookRoutes = new Hono<AppBindings>();

/** Every webhook endpoint with its recent delivery state; secrets are never returned. */
webhookRoutes.get('/', async (c) => c.json({ webhooks: await listWebhooks() }));

/** One webhook endpoint with its delivery log. */
webhookRoutes.get('/:id', async (c) => c.json(await getWebhook(c.req.param('id'))));

/** Registers an endpoint and returns its signing secret, this one time. */
webhookRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createWebhookSchema);
  const { endpoint, secret } = await createWebhook(input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'webhook.create',
    targetType: 'webhook',
    targetId: endpoint.id,
    metadata: {
      url: endpoint.url,
      allActions: endpoint.allActions,
      actions: endpoint.actions,
      enabled: endpoint.enabled,
      allowPrivateNetwork: endpoint.allowPrivateNetwork,
    },
  });
  return c.json({ ...endpoint, secret }, 201);
});

/** Changes a webhook endpoint; only sent fields change. */
webhookRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  const input = await parseBody(c, updateWebhookSchema);
  const fields = await updateWebhook(existing, input);
  if (fields.length > 0) {
    const saved = await loadWebhookOrThrow(existing.id);
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'webhook.update',
      targetType: 'webhook',
      targetId: existing.id,
      // Old and new: narrowing what a SIEM endpoint receives must leave a
      // record of what it used to (#258).
      metadata: { url: saved.url, fields, changes: diffUpdate(existing, saved, fields) },
    });
  }
  return c.json(await getWebhook(existing.id));
});

/** Deletes the endpoint and its delivery log; pending deliveries are dropped. */
webhookRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  const removed = await deleteWebhook(existing);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'webhook.delete',
    targetType: 'webhook',
    targetId: existing.id,
    metadata: { url: existing.url, ...removed },
  });
  return c.json({ ok: true });
});

/** Replaces the signing secret and returns the new one, this one time. */
webhookRoutes.post('/:id/rotate', async (c) => {
  const actor = currentUser(c);
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  const secret = await rotateWebhookSecret(existing);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'webhook.rotate',
    targetType: 'webhook',
    targetId: existing.id,
    metadata: { url: existing.url },
  });
  return c.json({ ...(await getWebhook(existing.id)), secret });
});

/** Sends a signed `webhook.test` event now and reports what the endpoint answered. */
webhookRoutes.post('/:id/test', async (c) => {
  const actor = currentUser(c);
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  return c.json(await sendTestDelivery(existing, { id: actor.id, email: actor.email }));
});

/** The endpoint's delivery log, newest first. */
webhookRoutes.get('/:id/deliveries', async (c) => {
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  const limit = Number(c.req.query('limit') ?? 50);
  return c.json({
    deliveries: await listDeliveries(existing.id, Number.isFinite(limit) ? limit : 50),
  });
});
