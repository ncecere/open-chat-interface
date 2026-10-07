import { eq, schema } from '@oci/db';
import {
  branchMessageSchema,
  compactThreadSchema,
  contentDisposition,
  createThreadSchema,
  DOCUMENT_FORMATS,
  forkMessageSchema,
  MESSAGE_TOO_LONG_TEXT,
  THREAD_HISTORY_MAX_PAGE_SIZE,
  THREAD_HISTORY_PAGE_SIZE,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  type ThreadSearchResult,
  updateThreadSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { clientIp } from '../lib/client-ip.js';
import { rateLimited, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import {
  assertCompactionPossible,
  defaultSummaryModel,
  NOTHING_TO_COMPACT,
} from '../services/chat/compaction.js';
import {
  clearCompactionFailure,
  compactionState,
  requestCompaction,
} from '../services/chat/compaction-queue.js';
import { consumeFileExport, exportReply } from '../services/documents/export.js';
import { exportFilename, exportThreadMarkdown, exportTimeZone } from '../services/export.js';
import {
  emptyTrash,
  listTrashedThreads,
  purgeTrashedThread,
  restoreThread,
  softDeleteThread,
} from '../services/lifecycle/trash.js';
import { chatRateLimit, threadCreateRateLimit } from '../services/limits/rate-limit.js';
import { resolveModelForRole } from '../services/models.js';
import {
  assertProjectsAllowed,
  getOwnedProject,
  moveThreadToProject,
} from '../services/projects.js';
import { activateReply } from '../services/replies.js';
import { roleFeatures } from '../services/role-features.js';
import { decodeThreadHistoryCursor, listThreadHistory } from '../services/thread-history.js';
import { searchThreads } from '../services/thread-search.js';
import { serializeThread } from '../services/thread-summary.js';
import {
  assertBranchingAllowed,
  assertNotLeavingUnusedThreads,
  assertTemporaryChatAllowed,
  branchFromUserMessage,
  createThread,
  destroyUnusedThread,
  forkedMessage,
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
  /**
   * `sidebar` (v0.9.1): the sidebar's general list, which leaves out
   * conversations in a project unless they are pinned. Those are listed under
   * their project instead (GET /api/projects/sidebar), so they no longer
   * crowd ordinary conversations out of the 200-row limit. Without the
   * parameter every conversation is returned, as before.
   */
  view: z.enum(['sidebar', 'history']).optional(),
  /**
   * `view=history` only (v0.9.1): the page size, and the `nextCursor` of the
   * previous page to continue from.
   */
  limit: z.coerce.number().int().min(1).max(THREAD_HISTORY_MAX_PAGE_SIZE).optional(),
  before: z.string().max(300).optional(),
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

const documentQuerySchema = z.object({ format: z.enum(DOCUMENT_FORMATS) });

/**
 * Live conversations, pinned first then newest, at most 200; `view=sidebar`
 * leaves out unpinned project conversations. `view=history` (Settings →
 * History) pages through all of them, newest activity first, returning
 * `nextCursor` (null on the last page) to pass back as `before`.
 */
threadRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const { search, archived, projectId, view, limit, before } = parseQuery(c, listQuerySchema);
  if (view === 'history') {
    if (projectId) throw validationFailed('History is not filtered by project');
    const cursor = before ? decodeThreadHistoryCursor(before) : undefined;
    if (cursor === null) throw validationFailed('That page cursor is not valid');
    const page = await listThreadHistory(user.id, {
      search,
      archived,
      before: cursor,
      limit: limit ?? THREAD_HISTORY_PAGE_SIZE,
    });
    return c.json({ threads: page.threads.map(serializeThread), nextCursor: page.nextCursor });
  }
  if (projectId) {
    await assertProjectsAllowed(user.role);
    await getOwnedProject(projectId, user.id);
  }
  // A role without projects has no project tree in its sidebar, so its
  // project conversations stay in the general list rather than vanish.
  const outsideProjects = view === 'sidebar' && (await roleFeatures(user.role)).projects;
  const threads = await listThreads(user.id, { search, archived, projectId, outsideProjects });
  return c.json({ threads: threads.map(serializeThread) });
});

/**
 * Starts a conversation, or answers 429 with Retry-After when the person starts them faster than their role's messages per minute or already has ten unused untitled ones from the last minute (v0.10.2).
 */
threadRoutes.post('/', async (c) => {
  const user = currentUser(c);
  // Before any work, like sending a message: bounds how fast conversations
  // can be started (v0.10.2), then refuses a tenth unused one in a minute.
  const limit = await threadCreateRateLimit(user.id, user.role);
  if (!limit.allowed) {
    throw rateLimited(
      'You are starting conversations too quickly. Try again in a moment.',
      limit.retryAfterSeconds,
    );
  }
  const input = await parseBody(c, createThreadSchema);
  await assertNotLeavingUnusedThreads(user.id, input.title);
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
  // Shares the hourly allowance with document exports (file output, v0.9).
  await consumeFileExport(user.id);
  // Dated in the person's own zone, which the download link sends (#211).
  const timeZone = exportTimeZone(c.req.query('timeZone'));
  const markdown = await exportThreadMarkdown(thread.id, user.id, timeZone);

  return c.body(markdown, 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': contentDisposition(exportFilename(thread.title, timeZone)),
    'cache-control': 'no-store',
  });
});

/**
 * Downloads one assistant reply on the active path as DOCX, PDF, XLSX or PPTX.
 *
 * XLSX holds its tables (422 when it has none). Owner only: 404 for anyone else, for
 * conversations in the trash, user messages and replaced replies. Counts
 * towards the hourly download allowance and is audited as `message.export`
 * with the format and size only.
 */
threadRoutes.get('/:id/messages/:messageId/export', async (c) => {
  const user = currentUser(c);
  const { format } = parseQuery(c, documentQuerySchema);
  const file = await exportReply({
    userId: user.id,
    threadId: c.req.param('id'),
    messageId: c.req.param('messageId'),
    format,
  });
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'message.export',
    targetType: 'message',
    targetId: file.messageId,
    metadata: { format, threadId: file.threadId, sizeBytes: file.bytes.byteLength },
    ipAddress: clientIp(c),
  });
  return c.body(file.bytes, 200, {
    'content-type': file.contentType,
    'content-disposition': file.disposition,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
});

threadRoutes.post('/:id/forks', async (c) => {
  const user = currentUser(c);
  await getOwnedThread(c.req.param('id'), user.id);

  await assertBranchingAllowed(user.role);

  const input = await parseBody(c, forkMessageSchema);
  const fork = await forkFromMessage(c.req.param('id'), user.id, input);
  // The copy of the message forked at: a question is answered in the fork.
  const message = await forkedMessage(fork.id, input.messageId);
  return c.json({ thread: serializeThread(fork), message }, 201);
});

threadRoutes.post('/:id/branches', async (c) => {
  const user = currentUser(c);
  await getOwnedThread(c.req.param('id'), user.id);

  await assertBranchingAllowed(user.role);

  const input = await parseBody(c, branchMessageSchema, [MESSAGE_TOO_LONG_TEXT]);
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

/**
 * The compaction in use (its summary and where the verbatim messages start),
 * whether a background summary is queued or being made (`pending`), and the
 * last failure of a summary the person asked for (`failure`, v0.10).
 */
threadRoutes.get('/:id/compaction', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  c.header('cache-control', 'no-store');
  return c.json(await compactionState(thread.id, user.id));
});

/**
 * Dismisses the report of a failed summary (v0.10) and returns the state as
 * GET does. Idempotent; owner only (404 otherwise).
 */
threadRoutes.delete('/:id/compaction/failure', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('id'), user.id);
  await clearCompactionFailure(thread.id, user.id);
  c.header('cache-control', 'no-store');
  return c.json(await compactionState(thread.id, user.id));
});

/**
 * "Summarise earlier messages now": queues a background summary of the
 * earlier turns, optionally with instructions for it, using the given model
 * (the composer's) or the latest reply's, and returns 202 at once with the
 * same body as GET. A request while one is queued or running is that
 * request. Never refused because a reply is generating. Owner only (404
 * otherwise); 422 when there is nothing to summarise yet or the model is too
 * small to summarise with; 429 when the person's allowance is spent. The
 * summary counts towards the person's usage.
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
  const slug = input.modelSlug ?? (await defaultSummaryModel(thread.id, user.id, user.role));
  if (!slug) throw validationFailed(NOTHING_TO_COMPACT);
  const model = await resolveModelForRole(slug, user.role);
  await assertCompactionPossible({
    user,
    threadId: thread.id,
    model,
    instructions: input.instructions,
  });
  await requestCompaction({
    threadId: thread.id,
    userId: user.id,
    modelSlug: model.slug,
    reason: 'manual',
    instructions: input.instructions,
  });
  return c.json(await compactionState(thread.id, user.id), 202);
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

/**
 * Renames (title, trimmed, 1–200 characters), pins, archives or moves a
 * conversation; only the sent fields change.
 */
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
 * Removes the person's conversation if it is still unused (no message, still
 * untitled), skipping the trash: what the page does when its first message
 * was refused and the person leaves it (#234). `removed` is false for one in
 * use, someone else's or one already gone; none of those is an error.
 */
threadRoutes.delete('/:id/unused', async (c) => {
  const user = currentUser(c);
  return c.json({ removed: await destroyUnusedThread(c.req.param('id'), user.id) });
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
