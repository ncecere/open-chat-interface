import { createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    loadEnv: () => ({
      ...original.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
      CHAT_STREAM_TTL_SECONDS: 60,
    }),
  };
});

import { errorHandler } from '../../middleware/error-handler.js';
import { chatRoutes } from '../../routes/chat.js';
import { ChatStreamStore, sharedRedis } from '../../services/chat-streams.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};
async function redisAvailable() {
  const probe = new Redis(redisUrl, redisOptions);
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
const available = (await livePostgresAvailable()) && (await redisAvailable());

describe.skipIf(!available)('live replay route reconciles exact durable ownership', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const redis = new Redis(redisUrl, redisOptions);
  const store = new ChatStreamStore(redis, 60);
  let runtime: Redis | null;
  let organizationId: string;
  let userId: string;
  let stranger: string;
  let app: Hono<AppBindings>;
  const keys: string[] = [];
  const requests: AbortController[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('chat_replay_recovery');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, organizationId);
    stranger = await seedUser(pool.db, organizationId);
    await redis.connect();
    runtime = await sharedRedis();
    expect(runtime).not.toBeNull();
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? userId,
        name: 'Replay fixture',
        email: 'replay@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
  });
  afterEach(async () => {
    for (const abort of requests.splice(0)) abort.abort();
    await Promise.all(bodies.splice(0).map((body) => (body.locked ? undefined : body.cancel())));
    vi.restoreAllMocks();
    if (keys.length) await redis.del(...keys.splice(0));
  });
  afterAll(async () => {
    redis.disconnect();
    runtime?.disconnect();
    try {
      await pool?.sql.end({ timeout: 1 });
    } finally {
      await live?.destroy();
    }
  });

  async function fixture(status: 'streaming' | 'complete' | 'error' | 'cancelled' = 'streaming') {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId, userId })
      .returning();
    const [message] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId,
        role: 'assistant',
        status,
        parts: [{ type: 'text', text: 'Canonical response' }],
      })
      .returning();
    const identity = { runId: message!.id, threadId: thread!.id, userId };
    const metadata = `oci:chat-stream:run:${identity.runId}:metadata`;
    keys.push(
      metadata,
      `oci:chat-stream:run:${identity.runId}:events`,
      `oci:chat-stream:thread:${identity.threadId}:active`,
    );
    expect(await store.begin(identity)).toBe('available');
    return { identity, metadata };
  }
  async function resume(threadId: string, owner = userId) {
    const abort = new AbortController();
    requests.push(abort);
    const response = await app.request(`/api/chat/${threadId}/stream`, {
      headers: { 'x-test-user': owner },
      signal: abort.signal,
    });
    if (response.body) bodies.push(response.body);
    return response;
  }

  it.each(['complete', 'error', 'cancelled'] as const)(
    'returns 204 for a durable %s run even with active cache metadata',
    async (status) => {
      const { identity, metadata } = await fixture(status);
      expect((await resume(identity.threadId)).status).toBe(204);
      expect(await redis.hget(metadata, 'status')).toBe('active');
    },
  );
  it('rejects a cached run whose durable claim is missing', async () => {
    const { identity } = await fixture();
    await pool.db.delete(schema.message).where(eq(schema.message.id, identity.runId));
    expect((await resume(identity.threadId)).status).toBe(204);
  });
  it('does not mistake a successor streaming claim for the cached original', async () => {
    const { identity } = await fixture('complete');
    const [successor] = await pool.db
      .insert(schema.message)
      .values({
        threadId: identity.threadId,
        userId,
        role: 'assistant',
        status: 'streaming',
        parts: [],
      })
      .returning();
    expect((await resume(identity.threadId)).status).toBe(204);
    const [saved] = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, successor!.id));
    expect(saved!.status).toBe('streaming');
  });
  it('rejects a cached identity that no longer owns its durable assistant', async () => {
    const { identity } = await fixture();
    await pool.db
      .update(schema.message)
      .set({ userId: stranger })
      .where(eq(schema.message.id, identity.runId));
    expect((await resume(identity.threadId)).status).toBe(204);
  });
  it('replays an owned live prefix without cancelling its producer when the reader leaves', async () => {
    const { identity, metadata } = await fixture();
    const chunk = `data: ${JSON.stringify({ type: 'start', messageId: identity.runId })}\n\n`;
    await store.append(identity.runId, chunk);
    const response = await resume(identity.threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-OCI-Chat-Run-Id')).toBe(identity.runId);
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(chunk);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    expect(await redis.hget(metadata, 'status')).toBe('active');
    expect(await redis.hget(metadata, 'cancelRequested')).toBeNull();
  });
  it('finishes an already-idle reader after durable completion without Redis finalization', async () => {
    const { identity, metadata } = await fixture();
    await store.append(
      identity.runId,
      `data: ${JSON.stringify({ type: 'start', messageId: identity.runId })}\n\n`,
    );
    const response = await resume(identity.threadId);
    expect(response.status).toBe(200);
    let text: string | undefined;
    const consumed = response.text().then((value) => {
      text = value;
    });
    try {
      await pool.db
        .update(schema.message)
        .set({ status: 'complete' })
        .where(eq(schema.message.id, identity.runId));
      await vi.waitFor(
        () => {
          expect(text).toContain('Live replay is no longer available');
          expect(text).toContain('[DONE]');
        },
        { timeout: 3500, interval: 25 },
      );
      expect(await redis.hget(metadata, 'status')).toBe('active');
    } finally {
      requests.at(-1)!.abort();
      await consumed;
    }
  }, 6000);
  it('reports initial database validation failure as unavailable, not absent', async () => {
    const { identity } = await fixture();
    vi.spyOn(pool.db, 'transaction').mockRejectedValueOnce(
      new Error('Injected private SQL detail'),
    );
    const response = await resume(identity.threadId);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Injected private SQL detail');
  });
  it.each(['foreign', 'deleted', 'expired'] as const)(
    'keeps %s thread access checks ahead of replay',
    async (kind) => {
      const { identity } = await fixture();
      if (kind === 'deleted')
        await pool.db
          .update(schema.thread)
          .set({ deletedAt: new Date() })
          .where(eq(schema.thread.id, identity.threadId));
      if (kind === 'expired')
        await pool.db
          .update(schema.thread)
          .set({ temporary: true, expiresAt: new Date(0) })
          .where(eq(schema.thread.id, identity.threadId));
      expect((await resume(identity.threadId, kind === 'foreign' ? stranger : userId)).status).toBe(
        404,
      );
    },
  );
});
