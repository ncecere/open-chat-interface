import { createDatabase, eq, schema, sql } from '@oci/db';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  controlConnection,
  gate,
  outageProxy,
  terminateEveryBackend,
  waitForLockWaiter,
} from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * A database failover at the moment a reply is saved (v0.11 design, section
 * 3), through the real chat route, PostgreSQL and Redis. The reply streams
 * through Redis, so the failover does not interrupt it; every backend is
 * terminated while the final save is running, and the save is retried on the
 * new connection instead of the finished reply being lost.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  /** Holds a turn between claiming its conversation and saving its message. */
  beforeSave: null as null | (() => Promise<void>),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return {
    loadEnv: () => ({
      ...original.loadEnv(),
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389',
      CHAT_STREAM_TTL_SECONDS: 120,
    }),
  };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) =>
    key === 'features'
      ? { webSearch: false, attachments: true, temporaryChat: true, branching: true }
      : key === 'roleFeatures'
        ? {
            roles: Object.fromEntries(
              ['admin', 'auditor', 'user', 'restricted'].map((r) => [r, { artifacts: false }]),
            ),
          }
        : {},
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => {
    await state.beforeSave?.();
    return '';
  },
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
async function redisAvailable() {
  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 500,
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
const available = (await livePostgresAvailable()) && (await redisAvailable());

describe.skipIf(!available)('live failover during a reply’s final save', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('failover_reply');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
  });
  afterAll(async () => {
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  function replyingModel(text: string) {
    state.model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: text });
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.enqueue({
                type: 'finish',
                usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
                finishReason: { unified: 'stop', raw: 'stop' },
              });
              controller.close();
            },
          }),
        }) as never,
    });
  }

  it('retries saving the new message when the failover lands as the turn is stored', async () => {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Failover turn' })
      .returning();
    replyingModel('Stored once');
    const control = controlConnection(live.connectionString);
    const claimed = gate();
    const locked = gate();
    state.beforeSave = async () => {
      state.beforeSave = null;
      claimed.open();
      await locked.promise;
    };
    try {
      const sending = app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: thread!.id,
          modelSlug: 'test-model',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Store me once' }] }],
        }),
      });
      await claimed.promise;
      await control.begin(async (tx) => {
        // The turn's transaction (thread-claim.ts, owner then conversation)
        // waits on these locks, then every backend goes.
        await tx`select id from thread where id = ${thread!.id} for update`;
        locked.open();
        await waitForLockWaiter(tx, '%for %');
        expect(await terminateEveryBackend(tx)).toBeGreaterThanOrEqual(1);
      });
      const response = await sending;
      // Before: 500 and the message was not stored.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Stored once');
    } finally {
      state.beforeSave = null;
      await control.end({ timeout: 1 });
    }
    await vi.waitFor(
      async () => {
        const rows = await pool.db
          .select()
          .from(schema.message)
          .where(eq(schema.message.threadId, thread!.id));
        expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
        expect(rows.find((row) => row.role === 'assistant')?.status).toBe('complete');
      },
      { timeout: 10_000, interval: 50 },
    );
  }, 30_000);

  it('retries the final save on the new connection and keeps the whole reply', async () => {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Failover reply' })
      .returning();
    const written = gate();
    const finish = gate();
    state.model = new MockLanguageModelV4({
      doStream: (async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'A whole answer' });
            written.open();
            await finish.promise;
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({
              type: 'finish',
              usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
              finishReason: { unified: 'stop', raw: 'stop' },
            });
            controller.close();
          },
        }),
      })) as never,
    });
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: thread!.id,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Answer me' }] }],
      }),
    });
    expect(response.status).toBe(200);
    const runId = response.headers.get('x-oci-chat-run-id')!;
    const reading = response.text();
    await written.promise;

    const control = controlConnection(live.connectionString);
    try {
      await control.begin(async (tx) => {
        // The final save waits on this row, then every backend is terminated.
        await tx`select id from message where id = ${runId} for update`;
        finish.open();
        await waitForLockWaiter(tx, 'update "message"%');
        expect(await terminateEveryBackend(tx)).toBeGreaterThanOrEqual(1);
      });
    } finally {
      await control.end({ timeout: 1 });
    }
    expect(await reading).toContain('A whole answer');

    // Before: the save failed, the reply stayed `streaming` with no text and
    // was later recovered as interrupted from what Redis captured.
    await vi.waitFor(
      async () => {
        const [reply] = await pool.db
          .select()
          .from(schema.message)
          .where(eq(schema.message.id, runId));
        expect(reply?.status).toBe('complete');
        expect(reply?.parts).toContainEqual(
          expect.objectContaining({ type: 'text', text: 'A whole answer' }),
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    const [event] = await pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.id, runId));
    expect(event).toMatchObject({ pending: false, tokensOut: 2 });
  }, 30_000);

  // An outage longer than the final save's retries (#231): the reply streamed
  // to its end, its save gave up, and once the database was back recovery
  // saved the whole answer as "interrupted because the server writing it
  // stopped", inviting a paid Retry.
  it('saves a finished reply as complete when its final save outlasted the outage', async () => {
    const { finalSaveRetry } = await import('../../services/chat/run-save.js');
    const { runLiveness, recoverInterruptedRun } = await import(
      '../../services/chat/run-recovery.js'
    );
    const { logger } = await import('../../lib/logger.js');
    const savedRetry = { ...finalSaveRetry };
    const savedLiveness = { ...runLiveness };
    Object.assign(finalSaveRetry, { budgetMs: 500, initialDelayMs: 50 });
    Object.assign(runLiveness, { staleMs: 600 });
    const proxy = await outageProxy(live.connectionString);
    const cut = createDatabase(proxy.url, { max: 4 });
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Long outage' })
      .returning();
    const written = gate();
    const finish = gate();
    state.model = new MockLanguageModelV4({
      doStream: (async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'The whole answer, ' });
            written.open();
            await finish.promise;
            controller.enqueue({ type: 'text-delta', id: 't', delta: 'to its last word.' });
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({
              type: 'finish',
              usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } },
              finishReason: { unified: 'stop', raw: 'stop' },
            });
            controller.close();
          },
        }),
      })) as never,
    });
    state.db = cut.db;
    vi.mocked(logger.error).mockClear();
    try {
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: thread!.id,
          modelSlug: 'test-model',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Answer me fully' }] }],
        }),
      });
      expect(response.status).toBe(200);
      const runId = response.headers.get('x-oci-chat-run-id')!;
      const reading = response.text();
      await written.promise;
      // PostgreSQL goes away mid-reply; the reply still streams to its end.
      await proxy.cut();
      finish.open();
      expect(await reading).toContain('to its last word.');
      await vi.waitFor(
        () =>
          expect(logger.error).toHaveBeenCalledWith(
            expect.anything(),
            'Failed to persist assistant message',
          ),
        { timeout: 10_000, interval: 50 },
      );

      // The database is back; the claim has gone quiet (its producer is done).
      await proxy.restore();
      await pool.db.execute(
        sql`update message set updated_at = now() - interval '1 minute' where id = ${runId}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await recoverInterruptedRun({ runId, threadId: thread!.id, userId: owner })).toBe(
        true,
      );
      const [reply] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, runId));
      expect(reply).toMatchObject({ status: 'complete', errorMessage: null });
      expect(reply?.parts).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: 'The whole answer, to its last word.',
          state: 'done',
        }),
      );
    } finally {
      state.db = pool.db;
      Object.assign(finalSaveRetry, savedRetry);
      Object.assign(runLiveness, savedLiveness);
      await cut.sql.end({ timeout: 1 });
      await proxy.close();
    }
  }, 30_000);
});
