import {
  answerToolApprovalsSchema,
  CHAT_HISTORY_MAX_PAGE_SIZE,
  CHAT_HISTORY_PAGE_SIZE,
  sendMessageSchema,
} from '@oci/shared';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, rateLimited, validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { setupApprovalContinuation } from '../services/chat/approvals.js';
import { type HistoryPageRequest, readConversationPage } from '../services/chat/history-page.js';
import { readOwnedRunState } from '../services/chat/run-state.js';
import { setupTurn } from '../services/chat/setup-turn.js';
import { streamResponse } from '../services/chat/stream-response.js';
import { cancelActiveChatRun, resumeActiveChatRun } from '../services/chat-streams.js';
import { chatRateLimit } from '../services/limits/rate-limit.js';
import { requestStartedAt } from '../services/observability/request-timing.js';
import { serializeThread } from '../services/thread-summary.js';
import { getOwnedThread, listConversation } from '../services/threads.js';

export const chatRoutes = new Hono<AppBindings>();

chatRoutes.use('*', requireAuth);

chatRoutes.post('/', async (c) => {
  const user = currentUser(c);

  // Checked before any work: a quota bounds how much is consumed over a window,
  // this bounds how fast requests arrive.
  const limit = await chatRateLimit(user.id, user.role);
  if (!limit.allowed) {
    throw rateLimited(
      'You are sending messages too quickly. Try again in a moment.',
      limit.retryAfterSeconds,
    );
  }

  const input = await parseBody(c, sendMessageSchema);
  const { turn, run } = await setupTurn(user, input);
  return streamResponse(turn, run, { receivedAt: requestStartedAt(c.req.raw) });
});

/**
 * Answers a reply's open tool approvals and continues the same assistant
 * message under the durable claim, streaming like a new reply. 404 for another
 * person's thread, 409 while a reply is generating, 422 when the reply is not
 * the latest or is not waiting on exactly these approvals.
 */
chatRoutes.post('/:threadId/approvals', async (c) => {
  const user = currentUser(c);
  const limit = await chatRateLimit(user.id, user.role);
  if (!limit.allowed) {
    throw rateLimited(
      'You are sending messages too quickly. Try again in a moment.',
      limit.retryAfterSeconds,
    );
  }
  const input = await parseBody(c, answerToolApprovalsSchema);
  const { turn, run } = await setupApprovalContinuation(user, c.req.param('threadId'), input);
  return streamResponse(turn, run, { receivedAt: requestStartedAt(c.req.raw) });
});

/** Replays the active SSE stream after authenticating the thread owner. */
chatRoutes.get('/:threadId/stream', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const resumed = await resumeActiveChatRun(thread.id, user.id, c.req.raw.signal, {
    readState: readOwnedRunState,
  }).catch(() => {
    // 500, not 503: the bundled proxy takes a replica that answers 503 out of
    // rotation (reserved for draining), and a Redis or database blip here
    // would answer 503 on every replica at once.
    throw new AppError('INTERNAL_ERROR', 'Could not check the saved response. Try again.', 500);
  });
  if (!resumed) return c.body(null, 204);

  return new Response(resumed.stream, {
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      'X-OCI-Stream-Persistence': resumed.persistence,
      'X-OCI-Chat-Run-Id': resumed.runId,
    },
  });
});

/** Explicit stop request; also reaches a producer running in another API process via Redis. */
chatRoutes.delete('/:threadId/stream', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const cancelled = await cancelActiveChatRun(thread.id, user.id);
  return c.json({ cancelled });
});

type StoredMessage = Awaited<ReturnType<typeof listConversation>>['messages'][number];

function toUIMessage(message: StoredMessage) {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      modelSlug: message.modelSlug,
      effort: message.effort,
      parentMessageId: message.parentMessageId,
      status: message.status,
      errorMessage: message.errorMessage,
      createdAt: message.createdAt.toISOString(),
    },
  };
}

const cursorSchema = z.string().min(1).max(200);
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(CHAT_HISTORY_MAX_PAGE_SIZE).optional(),
  before: cursorSchema.optional(),
  after: cursorSchema.optional(),
  around: cursorSchema.optional(),
});

/**
 * Returns stored messages in the AI SDK UI format for hydration: the active
 * conversation, plus `replies`, every reply to the latest turn (oldest first)
 * when it was retried, so the reader can switch between them. Empty otherwise.
 *
 * `thread` is the full conversation summary (v0.9.1; before, only its id,
 * `temporary` and `expiresAt`), so the sidebar can list an open project
 * conversation under its project even when it is not among the newest.
 *
 * In pages (v0.11): with `limit` (default 100, at most 500), `before`, `after`
 * or `around` (at most one of the last three), one page of the conversation
 * and a `page` object with its cursors and the conversation's length; see
 * `readConversationPage`. `replies` is filled only on a page that reaches the
 * latest message. Without any of them the whole conversation is returned in
 * the shape above, for clients before v0.11, share dialogs and anything that
 * needs all of it.
 */
chatRoutes.get('/:threadId/messages', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const query = parseQuery(c, historyQuerySchema);
  const anchors = [query.before, query.after, query.around].filter(Boolean).length;
  if (anchors > 1) throw validationFailed('Use one of before, after and around');

  if (query.limit === undefined && anchors === 0) {
    const { messages, replies } = await listConversation(thread.id);
    return c.json({
      thread: serializeThread(thread),
      messages: messages.map(toUIMessage),
      replies: replies.map(toUIMessage),
    });
  }

  const limit = query.limit ?? CHAT_HISTORY_PAGE_SIZE;
  const request: HistoryPageRequest = query.before
    ? { kind: 'before', cursor: query.before, limit }
    : query.after
      ? { kind: 'after', cursor: query.after, limit }
      : query.around
        ? { kind: 'around', messageId: query.around, limit }
        : { kind: 'latest', limit };
  const { messages, replies, page } = await readConversationPage(thread.id, request);
  return c.json({
    thread: serializeThread(thread),
    messages: messages.map(toUIMessage),
    replies: replies.map(toUIMessage),
    page,
  });
});
