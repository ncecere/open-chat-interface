import { randomUUID } from 'node:crypto';
import { type createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared by the chat-admission*.live.test.ts suites: the Redis probe, the chat
 * route, and helpers that create threads and uploads and post turns. Each
 * suite declares its own mocks and creates its own database.
 */

export const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
/** Whether Redis answers; only probed when PostgreSQL is available too. */
export async function redisAvailableFor(available: boolean) {
  if (!available) return false;
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 500,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The chat route, signed in as `x-test-user` or else the owner. */
export async function admissionApp(organizationId: string, owner: string) {
  const { chatRoutes } = await import('../src/routes/chat.js');
  const { errorHandler } = await import('../src/middleware/error-handler.js');
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-test-user') ?? owner,
      name: 'Test',
      email: 'test@example.test',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId,
    });
    await next();
  });
  app.route('/api/chat', chatRoutes);
  return app;
}

/** What the helpers need from a suite; read when a helper runs, so a replaced pool is used. */
export interface AdmissionSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly app: Hono<AppBindings>;
  readonly owner: string;
  readonly organizationId: string;
}

export function admissionHelpers(suite: AdmissionSuite) {
  async function thread(temporary = false) {
    const [row] = await suite.pool.db
      .insert(schema.thread)
      .values({
        userId: suite.owner,
        organizationId: suite.organizationId,
        temporary,
        expiresAt: temporary ? new Date(Date.now() + 60_000) : null,
      })
      .returning();
    return row!;
  }
  function post(
    threadId: string,
    text: string,
    extra: Record<string, unknown> = {},
    userId = suite.owner,
  ) {
    return suite.app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        ...extra,
      }),
    });
  }
  async function messages(threadId: string) {
    return suite.pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function attachment() {
    const [row] = await suite.pool.db
      .insert(schema.attachment)
      .values({
        organizationId: suite.organizationId,
        userId: suite.owner,
        filename: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        storageKey: randomUUID(),
        extractedText: 'text',
      })
      .returning();
    return row!;
  }

  return { thread, post, messages, attachment };
}
