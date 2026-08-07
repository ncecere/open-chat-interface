import { and, eq, schema } from '@oci/db';
import { createThreadSchema, updateThreadSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { createThread, getOwnedThread, listMessages, listThreads } from '../services/threads.js';

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
  const thread = await createThread(user.id, input.title);
  return c.json({ thread: serializeThread(thread) }, 201);
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

threadRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await db
    .delete(schema.thread)
    .where(and(eq(schema.thread.id, c.req.param('id')), eq(schema.thread.userId, user.id)));

  return c.json({ ok: true });
});
