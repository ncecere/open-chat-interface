import { createWebhookSchema, updateWebhookSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { failedReason } from '../../services/audit-test-details.js';
import { addUrlIssue } from '../../services/connectors/network.js';
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
  // The URL's network rules are checked with the rest of the body, so every
  // problem is reported at once, each at its field (#283).
  const input = await parseBody(
    c,
    createWebhookSchema.superRefine((body, ctx) =>
      addUrlIssue(ctx, body.url, { allowPrivateNetwork: body.allowPrivateNetwork }),
    ),
  );
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
  // Checked against what the endpoint becomes, with the rest of the body, so
  // every problem is reported at once, each at its field (#283);
  // updateWebhook checks again.
  const input = await parseBody(
    c,
    updateWebhookSchema.superRefine((body, ctx) => {
      addUrlIssue(ctx, body.url ?? existing.url, {
        allowPrivateNetwork: body.allowPrivateNetwork ?? existing.allowPrivateNetwork,
      });
      const actions = body.actions ?? existing.actions;
      if (!(body.allActions ?? existing.allActions) && actions.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['actions'],
          message: 'Choose at least one audit action, or all of them.',
        });
    }),
  );
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
  const result = await sendTestDelivery(existing, { id: actor.id, email: actor.email });
  // Audited as every other Test button is: it posts to an address an
  // administrator chose (#287). Not "webhook.test", the event the endpoint
  // was just sent, so an endpoint receiving every action can tell the two apart.
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'webhook.test.send',
    targetType: 'webhook',
    targetId: existing.id,
    metadata: {
      url: existing.url,
      ok: result.ok,
      status: result.status,
      ...failedReason(result, result.error),
    },
  });
  return c.json(result);
});

/** The endpoint's delivery log, newest first. */
webhookRoutes.get('/:id/deliveries', async (c) => {
  const existing = await loadWebhookOrThrow(c.req.param('id'));
  const limit = Number(c.req.query('limit') ?? 50);
  return c.json({
    deliveries: await listDeliveries(existing.id, Number.isFinite(limit) ? limit : 50),
  });
});
