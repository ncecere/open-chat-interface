import { createArtifactVersionSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  editArtifact,
  getArtifactDetail,
  getArtifactVersion,
  listThreadArtifacts,
} from '../services/artifacts/store.js';
import { getOwnedThread } from '../services/threads.js';

/**
 * Artifacts (v0.9). Owner only: anyone else, and any artifact of a
 * conversation in the trash, gets 404. Reading stays possible when the role's
 * `artifacts` switch is off (it is the person's own data); editing does not.
 */
export const artifactRoutes = new Hono<AppBindings>();

artifactRoutes.use('*', requireAuth);

const listQuerySchema = z.object({ threadId: z.string().min(1).max(200) });
const versionParamSchema = z.coerce.number().int().positive().max(1_000_000);

/** `GET /api/artifacts?threadId=…`: every artifact of one conversation, oldest first. */
artifactRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const { threadId } = parseQuery(c, listQuerySchema);
  const thread = await getOwnedThread(threadId, user.id);
  c.header('cache-control', 'no-store');
  return c.json({ artifacts: await listThreadArtifacts(thread.id, user.id) });
});

/** The artifact, its versions (newest first) and the current version's content. */
artifactRoutes.get('/:id', async (c) => {
  const user = currentUser(c);
  c.header('cache-control', 'no-store');
  return c.json(await getArtifactDetail(c.req.param('id'), user.id));
});

artifactRoutes.get('/:id/versions/:version', async (c) => {
  const user = currentUser(c);
  const version = versionParamSchema.safeParse(c.req.param('version'));
  c.header('cache-control', 'no-store');
  if (!version.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  return c.json(await getArtifactVersion(c.req.param('id'), user.id, version.data));
});

/**
 * A person's edit of a Markdown document, saved as a new version. 409 when
 * `baseVersion` is no longer the current one; HTML, SVG and Mermaid change
 * through the model (422).
 */
artifactRoutes.post('/:id/versions', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, createArtifactVersionSchema);
  const artifact = await editArtifact(c.req.param('id'), user, input);
  return c.json({ artifact }, 201);
});
