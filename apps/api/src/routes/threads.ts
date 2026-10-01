import { eq, schema } from '@oci/db';
import {
  branchMessageSchema,
  createThreadSchema,
  forkMessageSchema,
  updateThreadSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { exportFilename, exportThreadMarkdown } from '../services/export.js';
import {
  emptyTrash,
  listTrashedThreads,
  purgeTrashedThread,
  restoreThread,
  softDeleteThread,
} from '../services/lifecycle/trash.js';
import {
  assertBranchingAllowed,
  branchFromUserMessage,
  createThread,
  forkFromMessage,
  getOwnedThread,
  listMessages,
  listThreads,
} from '../services/threads.js';

export const threadRoutes = new Hono<AppBindings>();

threadRoutes.use('*', requireAuth);

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

function serializeThread(thread: typeof schema.thread.$inferSelect) {
  return {
    id: thread.id,
    title: thread.title,
    pinned: thread.pinned,
    archived: thread.archived,
    temporary: thread.temporary,
    expiresAt: thread.expiresAt?.toISOString() ?? null,
    parentThreadId: thread.parentThreadId,
    branchedFromMessageId: thread.branchedFromMessageId,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

threadRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const { search, archived } = parseQuery(c, listQuerySchema);
  const threads = await listThreads(user.id, { search, archived });
  return c.json({ threads: threads.map(serializeThread) });
});

threadRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, createThreadSchema);
  const thread = await createThread({
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    title: input.title,
    temporary: input.temporary,
  });
  return c.json({ thread: serializeThread(thread) }, 201);
});

/** Trash listing is a fixed path, so it must be declared before `/:id`. */
threadRoutes.get('/trash', async (c) => {
  const user = currentUser(c);
  return c.json({ threads: await listTrashedThreads(user.id) });
});

threadRoutes.delete('/trash', async (c) => {
  const user = currentUser(c);
  const purged = await emptyTrash(user.id);
  return c.json({ purged });
});

threadRoutes.post('/:id/restore', async (c) => {
  const user = currentUser(c);
  await restoreThread(c.req.param('id'), user.id);
  return c.json({ ok: true });
});

/** Destroys a trashed thread now, without waiting out the grace window. */
threadRoutes.delete('/:id/permanent', async (c) => {
  const user = currentUser(c);
  await purgeTrashedThread(c.req.param('id'), user.id);
  return c.json({ ok: true });
});

/**
 * Downloads one conversation as Markdown.
 *
 * The felt gap is at deletion: that is the moment someone wishes they had kept
 * a copy. Ownership is checked the same way as any other read.
 */
threadRoutes.get('/:id/export', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  const markdown = await exportThreadMarkdown(thread.id);

  return c.body(markdown, 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${exportFilename(thread.title)}"`,
    'cache-control': 'no-store',
  });
});

threadRoutes.post('/:id/forks', async (c) => {
  const user = currentUser(c);
  await getOwnedThread(c.req.param('id'), user.id);

  await assertBranchingAllowed(user.role);

  const input = await parseBody(c, forkMessageSchema);
  const fork = await forkFromMessage(c.req.param('id'), user.id, input);
  return c.json({ thread: serializeThread(fork) }, 201);
});

threadRoutes.post('/:id/branches', async (c) => {
  const user = currentUser(c);
  await getOwnedThread(c.req.param('id'), user.id);

  await assertBranchingAllowed(user.role);

  const input = await parseBody(c, branchMessageSchema);
  const result = await branchFromUserMessage(c.req.param('id'), user.id, input);

  return c.json(
    {
      thread: serializeThread(result.thread),
      message: {
        id: result.message.id,
        modelSlug: result.message.modelSlug,
        effort: result.message.effort,
      },
    },
    201,
  );
});

threadRoutes.get('/:id', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  const messages = await listMessages(thread.id);

  return c.json({
    thread: serializeThread(thread),
    messages: messages.map((message) => ({
      id: message.id,
      threadId: message.threadId,
      role: message.role,
      parts: message.parts,
      modelSlug: message.modelSlug,
      effort: message.effort,
      parentMessageId: message.parentMessageId,
      status: message.status,
      errorMessage: message.errorMessage,
      tokensIn: message.tokensIn,
      tokensOut: message.tokensOut,
      durationMs: message.durationMs,
      createdAt: message.createdAt.toISOString(),
    })),
  });
});

threadRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  const patch = await parseBody(c, updateThreadSchema);

  const [updated] = await db
    .update(schema.thread)
    .set(patch)
    .where(eq(schema.thread.id, thread.id))
    .returning();

  return c.json({ thread: updated ? serializeThread(updated) : null });
});

/**
 * Moves the thread to the trash rather than destroying it. Automatic retention
 * uses the same path, so one recovery story covers both.
 */
threadRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await softDeleteThread(c.req.param('id'), user.id, 'user');
  return c.json({ ok: true });
});
