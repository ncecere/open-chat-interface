import { Hono } from 'hono';
import { z } from 'zod';
import { notFound, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import {
  assertShareLinkManagementAllowed,
  createShareLink,
  getPublicShare,
  listShareLinks,
  revokeShareLink,
} from '../services/share-links.js';

export const shareLinkRoutes = new Hono<AppBindings>();

const publicSlugSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const idSchema = z.string().min(1).max(200);
const createShareLinkSchema = z
  .object({
    upToMessageId: z.string().min(1).max(200).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

function serializeOwnerLink(link: Awaited<ReturnType<typeof listShareLinks>>[number]) {
  return {
    id: link.id,
    slug: link.slug,
    path: `/share/${link.slug}`,
    upToMessageId: link.upToMessageId,
    viewCount: link.viewCount,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

/** Anonymous, read-only endpoint. It is deliberately the only public route in this module. */
shareLinkRoutes.get('/:slug', async (c) => {
  const parsed = publicSlugSchema.safeParse(c.req.param('slug'));
  if (!parsed.success) throw notFound('Share link not found');

  const share = await getPublicShare(parsed.data);
  return c.json(share);
});

shareLinkRoutes.get('/threads/:threadId', requireAuth, async (c) => {
  const user = currentUser(c);
  await assertShareLinkManagementAllowed(user.role);

  const threadId = idSchema.parse(c.req.param('threadId'));
  const links = await listShareLinks(threadId, user.id);
  return c.json({ links: links.map(serializeOwnerLink) });
});

shareLinkRoutes.post('/threads/:threadId', requireAuth, async (c) => {
  const user = currentUser(c);
  await assertShareLinkManagementAllowed(user.role);

  const threadId = idSchema.parse(c.req.param('threadId'));
  const input = await parseBody(c, createShareLinkSchema);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw validationFailed('Expiration must be a valid date');
  }

  const link = await createShareLink(threadId, user.id, {
    upToMessageId: input.upToMessageId,
    expiresAt,
  });
  return c.json({ link: serializeOwnerLink(link) }, 201);
});

shareLinkRoutes.delete('/links/:linkId', requireAuth, async (c) => {
  const user = currentUser(c);
  await assertShareLinkManagementAllowed(user.role);

  const linkId = idSchema.parse(c.req.param('linkId'));
  const link = await revokeShareLink(linkId, user.id);
  return c.json({ link: serializeOwnerLink(link) });
});
