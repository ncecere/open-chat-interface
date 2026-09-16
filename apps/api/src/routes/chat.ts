import { sendMessageSchema } from '@oci/shared';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { Hono } from 'hono';
import { rateLimited } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { prepareTurn } from '../services/chat/prepare-turn.js';
import { acquireRun } from '../services/chat/run-lifecycle.js';
import { streamResponse } from '../services/chat/stream-response.js';
import { cancelActiveChatRun, resumeActiveChatRun } from '../services/chat-streams.js';
import { chatRateLimit } from '../services/limits/rate-limit.js';
import { getOwnedThread, listMessages } from '../services/threads.js';

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
  const turn = await prepareTurn(user, input);
  const run = await acquireRun(turn);
  return streamResponse(turn, run);
});

/** Replays the active SSE stream after authenticating the thread owner. */
chatRoutes.get('/:threadId/stream', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const resumed = await resumeActiveChatRun(thread.id, user.id, c.req.raw.signal);
  if (!resumed) return c.body(null, 204);

  return new Response(resumed.stream, {
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      'X-OCI-Stream-Persistence': resumed.persistence,
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

/** Returns stored messages in the AI SDK UI format for hydration. */
chatRoutes.get('/:threadId/messages', async (c) => {
  const user = currentUser(c);
  const thread = await getOwnedThread(c.req.param('threadId'), user.id);
  const messages = await listMessages(thread.id);

  return c.json({
    thread: {
      id: thread.id,
      temporary: thread.temporary,
      expiresAt: thread.expiresAt?.toISOString() ?? null,
    },
    messages: messages.map((message) => ({
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
    })),
  });
});
