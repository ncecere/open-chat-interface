import { and, eq, schema } from '@oci/db';
import { upsertBroadcastSchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { listBroadcasts } from '../../services/broadcasts.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { diffUpdate } from '../../services/settings-diff.js';

export const broadcastRoutes = new Hono<AppBindings>();

broadcastRoutes.get('/', async (c) => {
  return c.json({ broadcasts: await listBroadcasts() });
});

broadcastRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertBroadcastSchema);
  const organizationId = await getDefaultOrganizationId();

  const [created] = await db
    .insert(schema.broadcast)
    .values({
      organizationId,
      title: input.title,
      body: input.body,
      level: input.level,
      audienceRoles: input.audienceRoles,
      dismissable: input.dismissable,
      published: input.published,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      createdByUserId: actor.id,
    })
    .returning({ id: schema.broadcast.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'broadcast.create',
    targetType: 'broadcast',
    targetId: created?.id,
    metadata: { title: input.title, level: input.level, published: input.published },
  });

  return c.json({ id: created?.id }, 201);
});

/** What an edit can change, for its audit entry. */
const BROADCAST_FIELDS = [
  'title',
  'body',
  'level',
  'audienceRoles',
  'dismissable',
  'published',
  'startsAt',
  'endsAt',
] as const;

broadcastRoutes.put('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const input = await parseBody(c, upsertBroadcastSchema);
  const organizationId = await getDefaultOrganizationId();
  const where = and(
    eq(schema.broadcast.id, id),
    eq(schema.broadcast.organizationId, organizationId),
  );
  const [existing] = await db.select().from(schema.broadcast).where(where).limit(1);

  const updated = await db
    .update(schema.broadcast)
    .set({
      title: input.title,
      body: input.body,
      level: input.level,
      audienceRoles: input.audienceRoles,
      dismissable: input.dismissable,
      published: input.published,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      updatedAt: new Date(),
    })
    .where(where)
    .returning();

  const [saved] = updated;
  if (!saved || !existing) throw notFound('Announcement not found');

  // A save that changed nothing is not recorded, nor sent to webhooks, as
  // for webhook edits (#258, #287).
  const changes = diffUpdate(existing, saved, BROADCAST_FIELDS);
  if (changes.length > 0)
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'broadcast.update',
      targetType: 'broadcast',
      targetId: id,
      // Which fields changed and from what; the window and audience were not
      // recorded at all (#258).
      metadata: { title: input.title, published: input.published, changes },
    });

  return c.json({ ok: true });
});

broadcastRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const organizationId = await getDefaultOrganizationId();

  const removed = await db
    .delete(schema.broadcast)
    .where(and(eq(schema.broadcast.id, id), eq(schema.broadcast.organizationId, organizationId)))
    .returning({
      title: schema.broadcast.title,
      body: schema.broadcast.body,
      level: schema.broadcast.level,
      audienceRoles: schema.broadcast.audienceRoles,
      published: schema.broadcast.published,
    });

  const [announcement] = removed;
  if (!announcement) throw notFound('Announcement not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'broadcast.delete',
    targetType: 'broadcast',
    targetId: id,
    metadata: announcement,
  });

  return c.json({ ok: true });
});

/**
 * Clears everyone's dismissals, so an updated announcement is shown again.
 *
 * Editing alone deliberately does not do this: fixing a typo should not
 * re-interrupt everyone who already read and hid the message.
 */
broadcastRoutes.post('/:id/reshow', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  const cleared = await db
    .delete(schema.broadcastDismissal)
    .where(eq(schema.broadcastDismissal.broadcastId, id))
    .returning({ id: schema.broadcastDismissal.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'broadcast.reshow',
    targetType: 'broadcast',
    targetId: id,
    metadata: { cleared: cleared.length },
  });

  return c.json({ cleared: cleared.length });
});
