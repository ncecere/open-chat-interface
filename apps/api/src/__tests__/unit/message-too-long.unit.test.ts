import { MESSAGE_TEXT_MAX_LENGTH } from '@oci/shared';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../../middleware/context.js';

/**
 * A message over the length limit, through the real chat and branch routes,
 * schemas and error handler (#247): the refusal says what the limit is and
 * what to do, not only "Request validation failed". Rate limiting, the
 * conversation's owner check and the turn itself are stand-ins; validation
 * refuses the body before any of the turn runs.
 */
const mocks = vi.hoisted(() => ({ setupTurn: vi.fn() }));
vi.mock('../../db/index.js', () => ({ db: {} }));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
  threadCreateRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/chat/setup-turn.js', () => ({ setupTurn: mocks.setupTurn }));
vi.mock('../../services/threads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/threads.js')>()),
  getOwnedThread: async (id: string) => ({ id }),
  assertBranchingAllowed: async () => {},
}));

const TOO_LONG = `Walk4 long: ${'x '.repeat(MESSAGE_TEXT_MAX_LENGTH / 2)}`;
const EXPECTED = 'Messages can be up to 100,000 characters. Attach long text as a file instead.';

let app: Hono<AppBindings>;
beforeAll(async () => {
  const { chatRoutes } = await import('../../routes/chat.js');
  const { threadRoutes } = await import('../../routes/threads.js');
  const { errorHandler } = await import('../../middleware/error-handler.js');
  app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: 'user-1',
      name: 'Test',
      email: 'test@example.test',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId: 'org-1',
    } as never);
    await next();
  });
  app.route('/api/chat', chatRoutes);
  app.route('/api/threads', threadRoutes);
});

async function post(path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error: unknown } };
}

describe('a message longer than the limit (#247)', () => {
  it('is refused with the limit and what to do instead when sent', async () => {
    const { status, body } = await post('/api/chat', {
      threadId: 'thread-1',
      modelSlug: 'test-model',
      messages: [{ role: 'user', parts: [{ type: 'text', text: TOO_LONG }] }],
    });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: EXPECTED });
    expect(mocks.setupTurn).not.toHaveBeenCalled();
  });

  it('is refused the same way when an edited message is branched', async () => {
    const { status, body } = await post('/api/threads/thread-1/branches', {
      messageId: 'message-1',
      text: TOO_LONG,
    });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: EXPECTED });
  });

  it('still says only that the request was invalid for any other mistake', async () => {
    const { status, body } = await post('/api/chat', { threadId: 'thread-1', messages: [] });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ message: 'Request validation failed' });
  });
});
