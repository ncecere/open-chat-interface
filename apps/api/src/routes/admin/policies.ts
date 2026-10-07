import { createHash } from 'node:crypto';
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
import { listPolicyAcceptances } from '../../services/policy-acceptances.js';
import { diffUpdate, type SettingChange } from '../../services/settings-diff.js';

export const policyRoutes = new Hono<AppBindings>();

policyRoutes.get('/', async (c) => {
  return c.json({ policies: await listPolicies() });
});

/**
 * Who accepted one version and when, with their email, for administrators and
 * auditors (#373): the latest 200, and the counts of accounts that exist and of
 * accounts deleted since.
 */
policyRoutes.get('/:id/acceptances', async (c) => {
  const result = await listPolicyAcceptances(c.req.param('id'));
  if (!result) throw notFound('Policy version not found');
  return c.json(result);
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

  const published = await publishPolicy(id);
  if (published.outcome === 'not-found') throw notFound('Policy version not found');
  if (published.outcome === 'already-published')
    throw conflict(
      `Version ${published.version} is already published (${published.publishedAt.toISOString()}). A published version cannot be published again or changed: its publish time is the record of when people were first asked to accept it.`,
    );
  if (published.outcome === 'superseded')
    throw conflict(
      `Version ${published.version} is older than version ${published.currentVersion}, which is in force, so nobody would ever be shown it. Create a new version with its wording instead.`,
    );

  // Which version and title, as the entry for publishing at creation has (#371):
  // it carried only the policy's ID, so the log did not say what everybody had
  // just been asked to accept.
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'policy.publish',
    targetType: 'usage_policy',
    targetId: id,
    metadata: { version: published.version, title: published.title },
  });

  return c.json({ ok: true });
});

function draftOutcome(result: DraftChange) {
  if (result.outcome === 'not-found') throw notFound('Policy version not found');
  if (result.outcome === 'published') {
    throw conflict(
      'A published version cannot be changed or deleted: people may have accepted its wording. Create a new version instead.',
    );
  }
  return result;
}

/** The text as a marker: its length and digest, which tell whether it changed (#284). */
const textMarker = (text: string) => ({
  characters: text.length,
  sha256: createHash('sha256').update(text).digest('hex'),
});

/**
 * What an edit changed, as it was and became (#221, #258): the title in full,
 * and the text, which can run to 50,000 characters, only as its length and
 * digest, so the entry says whether the wording changed without copying the
 * policy into the audit log and every webhook that receives it (#284).
 */
function policyChanges(
  before: { title: string; body: string },
  after: { title: string; body: string },
): SettingChange[] {
  const changes = diffUpdate({ title: before.title }, { title: after.title });
  if (before.body !== after.body)
    changes.push({ key: 'body', before: textMarker(before.body), after: textMarker(after.body) });
  return changes;
}

/** Rewords a draft. */
policyRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const input = await parseBody(c, updatePolicyDraftSchema);
  const changed = draftOutcome(await updatePolicyDraft(id, input));
  const previous = changed.previous ?? { title: changed.title, body: input.body };
  const changes = policyChanges(previous, { title: changed.title, body: input.body });

  // A save that changed nothing is not recorded, as for webhooks (#258, #287).
  if (changes.length > 0)
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'policy.update',
      targetType: 'usage_policy',
      targetId: id,
      metadata: {
        version: changed.version,
        title: changed.title,
        textChanged: changes.some((change) => change.key === 'body'),
        changes,
      },
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
