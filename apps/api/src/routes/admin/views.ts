import { and, desc, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseQuery } from '../../middleware/validate.js';
import { getDefaultOrganizationId } from '../../services/organization.js';

export const viewRoutes = new Hono<AppBindings>();

const SURFACES = ['users', 'audit'] as const;

const listQuerySchema = z.object({
  surface: z.enum(SURFACES),
});

const createSchema = z.object({
  surface: z.enum(SURFACES),
  name: z.string().trim().min(1).max(80),
  /**
   * The filters as a flat query object, stored whole. Keeping this opaque
   * means adding a filter to a list needs no migration here.
   */
  filters: z.record(z.string(), z.string()).default({}),
});

viewRoutes.get('/', async (c) => {
  const actor = currentUser(c);
  const { surface } = parseQuery(c, listQuerySchema);

  const rows = await db
    .select()
    .from(schema.savedView)
    .where(and(eq(schema.savedView.userId, actor.id), eq(schema.savedView.surface, surface)))
    .orderBy(desc(schema.savedView.createdAt));

  return c.json({
    views: rows.map((row) => ({
      id: row.id,
      name: row.name,
      surface: row.surface,
      filters: row.filters,
    })),
  });
});

viewRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createSchema);
  const organizationId = await getDefaultOrganizationId();

  // Saving over a name replaces it, which is what "save" means when the name
  // is already in the list; refusing would make the button feel broken.
  const [row] = await db
    .insert(schema.savedView)
    .values({
      organizationId,
      userId: actor.id,
      surface: input.surface,
      name: input.name,
      filters: input.filters,
    })
    .onConflictDoUpdate({
      target: [schema.savedView.userId, schema.savedView.surface, schema.savedView.name],
      set: { filters: input.filters, updatedAt: new Date() },
    })
    .returning({ id: schema.savedView.id });

  return c.json({ id: row?.id }, 201);
});

viewRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);

  // Scoped to the owner: an identifier alone must not reach somebody else's
  // saved view.
  const deleted = await db
    .delete(schema.savedView)
    .where(and(eq(schema.savedView.id, c.req.param('id')), eq(schema.savedView.userId, actor.id)))
    .returning({ id: schema.savedView.id });

  if (deleted.length === 0) throw notFound('Saved view not found');
  return c.json({ ok: true });
});
