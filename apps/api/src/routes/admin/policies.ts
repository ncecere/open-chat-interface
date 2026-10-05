import { updatePolicyDraftSchema, upsertUsagePolicySchema } from '@oci/shared';
import { Hono } from 'hono';
import { conflict, notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import {
  createPolicyVersion,
  type DraftChange,
  deletePolicyDraft,
  listPolicies,
  publishPolicy,
  updatePolicyDraft,
} from '../../services/onboarding.js';

export const policyRoutes = new Hono<AppBindings>();

policyRoutes.get('/', async (c) => {
  return c.json({ policies: await listPolicies() });
});

/**
 * Creates the next version.
 *
 * A published version is never updated: an acceptance records agreement to
 * specific words, so changing it would make that record inaccurate. A change
 * to a published policy is always a new version. Drafts, which nobody has been
 * asked to accept, can be reworded or deleted below.
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

function draftOutcome(result: DraftChange): { version: number; title: string } {
  if (result.outcome === 'not-found') throw notFound('Policy version not found');
  if (result.outcome === 'published') {
    throw conflict(
      'A published version cannot be changed or deleted: people may have accepted its wording. Create a new version instead.',
    );
  }
  return result;
}

/** Rewords a draft. */
policyRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const input = await parseBody(c, updatePolicyDraftSchema);
  const changed = draftOutcome(await updatePolicyDraft(id, input));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'policy.update',
    targetType: 'usage_policy',
    targetId: id,
    metadata: { version: changed.version, title: changed.title },
  });

  return c.json({ ok: true });
});

/** Deletes a draft. */
policyRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const deleted = draftOutcome(await deletePolicyDraft(id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'policy.delete',
    targetType: 'usage_policy',
    targetId: id,
    // The row is gone, so the entry carries what it was.
    metadata: { version: deleted.version, title: deleted.title },
  });

  return c.json({ ok: true });
});
