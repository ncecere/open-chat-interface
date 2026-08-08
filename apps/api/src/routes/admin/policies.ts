import { upsertUsagePolicySchema } from '@oci/shared';
import { Hono } from 'hono';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { createPolicyVersion, listPolicies, publishPolicy } from '../../services/onboarding.js';

export const policyRoutes = new Hono<AppBindings>();

policyRoutes.get('/', async (c) => {
  return c.json({ policies: await listPolicies() });
});

/**
 * Creates the next version.
 *
 * There is no update route on purpose: an acceptance records agreement to
 * specific words, so changing a published policy would make that record
 * inaccurate. A change is always a new version.
 */
policyRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertUsagePolicySchema);

  const created = await createPolicyVersion({
    title: input.title,
    body: input.body,
    publish: input.publish,
    createdByUserId: actor.id,
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: input.publish ? 'policy.publish' : 'policy.draft',
    targetType: 'usage_policy',
    targetId: created.id,
    metadata: { version: created.version, title: input.title },
  });

  return c.json(created, 201);
});

policyRoutes.post('/:id/publish', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  if (!(await publishPolicy(id))) throw notFound('Policy version not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'policy.publish',
    targetType: 'usage_policy',
    targetId: id,
  });

  return c.json({ ok: true });
});
