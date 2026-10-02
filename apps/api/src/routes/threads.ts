import { eq, schema } from '@oci/db';
import {
  branchMessageSchema,
  compactThreadSchema,
  createThreadSchema,
  forkMessageSchema,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  type ThreadSearchResult,
  updateThreadSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { rateLimited, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  compactThreadNow,
  latestCompaction,
  latestReplyModel,
  NOTHING_TO_COMPACT,
  serializeCompaction,
} from '../services/chat/compaction.js';
import { exportFilename, exportThreadMarkdown } from '../services/export.js';
import {
  emptyTrash,
  listTrashedThreads,
  purgeTrashedThread,
  restoreThread,
  softDeleteThread,
} from '../services/lifecycle/trash.js';
import { chatRateLimit } from '../services/limits/rate-limit.js';
import { resolveModelForRole } from '../services/models.js';
import {
  assertProjectsAllowed,
  getOwnedProject,
  moveThreadToProject,
} from '../services/projects.js';
import { activateReply } from '../services/replies.js';
import { searchThreads } from '../services/thread-search.js';
import {
  assertBranchingAllowed,
  assertTemporaryChatAllowed,
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
  /** Only conversations in this project (the caller's own). */
  projectId: z.string().min(1).max(200).optional(),
});

/**
 * Raw input is accepted up to a generous bound so a pasted sentence is not an
 * error; the search itself reads only the first 200 characters.
 */
const searchQuerySchema = z.object({
  q: z.string().max(2000),
  // A larger limit is clamped rather than refused.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(THREAD_SEARCH_DEFAULT_LIMIT)
    .transform((value) => Math.min(value, THREAD_SEARCH_MAX_LIMIT)),
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
    projectId: thread.projectId,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

threadRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const { search, archived, projectId } = parseQuery(c, listQuerySchema);
  if (projectId) {
    await assertProjectsAllowed(user.role);
    await getOwnedProject(projectId, user.id);
  }
  const threads = await listThreads(user.id, { search, archived, projectId });
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
    projectId: input.projectId,
  });
  return c.json({ thread: serializeThread(thread) }, 201);
});

/**
 * Full-text search over titles and message text, best match first. Declared
 * before `/:id`. The older `GET /threads?search=` (title substring) remains for
 * existing callers.
 */
threadRoutes.get('/search', async (c) => {
  const user = currentUser(c);
  const { q, limit } = parseQuery(c, searchQuerySchema);
  const hits = await searchThreads(user.id, q, { limit });
  const results: ThreadSearchResult[] = hits.map((hit) => ({
    thread: serializeThread(hit.thread),
    rank: hit.rank,
    titleHighlight: hit.titleHighlight,
    matches: hit.matches,
  }));
  c.header('cache-control', 'no-store');
  return c.json({ results });
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

/**
 * Chooses which reply to the latest turn is active: the one shown, sent to the
 * model as context, exported and shared. Refused (409) while a reply in this
 * thread is generating, and (422) for any reply but one to the latest turn.
 * Like retrying, it needs no branching permission: nothing new is created.
 */
threadRoutes.patch('/:id/messages/:messageId/active', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  const result = await activateReply(thread.id, user.id, c.req.param('messageId'));
  return c.json(result);
});

/** The compaction in use: its summary and where the verbatim messages start. */
threadRoutes.get('/:id/compaction', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  const compaction = await latestCompaction(thread.id, user.id);
  c.header('cache-control', 'no-store');
  return c.json({ compaction: compaction ? serializeCompaction(compaction) : null });
});

/**
 * "Compact conversation": summarise the earlier turns now, optionally with
 * instructions for the summary, using the given model (the composer's) or the
 * latest reply's. Owner only (404 otherwise); 409 while a reply is generating;
 * 422 when there is nothing to summarise yet. The summary call counts towards
 * the person's usage and is refused when their allowance is spent.
 */
threadRoutes.post('/:id/compact', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  if (thread.temporary) await assertTemporaryChatAllowed(user.role);
  const limit = await chatRateLimit(user.id, user.role);
  if (!limit.allowed)
    throw rateLimited(
      'You are sending messages too quickly. Try again in a moment.',
      limit.retryAfterSeconds,
    );
  const input = await parseBody(c, compactThreadSchema);
  const slug = input.modelSlug ?? (await latestReplyModel(thread.id));
  if (!slug) throw validationFailed(NOTHING_TO_COMPACT);
  const model = await resolveModelForRole(slug, user.role);
  const compaction = await compactThreadNow(user, thread.id, {
    instructions: input.instructions,
    model,
  });
  return c.json({ compaction: serializeCompaction(compaction) }, 201);
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
  const { projectId, ...patch } = await parseBody(c, updateThreadSchema);

  // Moving into or out of a project checks the role and the project's owner
  // before anything is written.
  let updated: typeof schema.thread.$inferSelect | undefined;
  if (projectId !== undefined) {
    await assertProjectsAllowed(user.role);
    updated = await moveThreadToProject(thread.id, user.id, projectId);
  }
  if (Object.keys(patch).length > 0) {
    [updated] = await db
      .update(schema.thread)
      .set(patch)
      .where(eq(schema.thread.id, thread.id))
      .returning();
  }
  return c.json({ thread: serializeThread(updated ?? thread) });
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
