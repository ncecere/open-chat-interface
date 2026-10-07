import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { serve } from '@hono/node-server';
import { createDatabase, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { startRateLimitedProvider } from '../../../test/rate-limited-provider.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * A reply stopped by the drain limit or by the person, through a real
 * OpenAI-compatible gateway over HTTP rather than a mock model (#136). The
 * mocks in shutdown-drain.live.test.ts end their stream with an AbortError;
 * a fetch-based provider ends it with whatever the controller was aborted
 * with, and a bare-string reason made every stop a stream error that was
 * saved as complete, with no interrupted note and no Retry.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  model: null as unknown,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
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
    providerKind: 'openai-compatible',
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
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
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

/** Reads a stream until `done(text)` holds (or it ends); returns the reader to continue. */
async function readUntil(body: ReadableStream<Uint8Array>, done: (text: string) => boolean) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return {
    rest: async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return text;
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe.skipIf(!available)('live stops through an OpenAI-compatible gateway (#136)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let provider: Awaited<ReturnType<typeof startRateLimitedProvider>>;
  let owner: string;
  let server: Server;
  let base: string;
  let shutdown: (signal: string) => Promise<void>;

  beforeAll(async () => {
    live = await createLiveDatabase('shutdown_drain_gateway');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    // A long reply: far longer than the drain limit or the time to Stop.
    provider = await startRateLimitedProvider({ chunks: 400, chunkDelayMs: 40 });
    state.model = createOpenAICompatible({
      name: 'gateway',
      baseURL: provider.baseUrl,
      apiKey: 'test',
      includeUsage: true,
    })('gateway-model');
  });
  beforeEach(async () => {
    const drain = await import('../../lib/drain.js');
    const runs = await import('../../services/chat/active-runs.js');
    drain.resetDrainForTests();
    runs.resetActiveRunsForTests();
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { endChatReplays } = await import('../../services/chat-streams.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('/api/chat/*', async (c, next) => {
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
    server = await new Promise<Server>((resolve) => {
      const started = serve({ fetch: drain.withDrain(app.fetch), port: 0 }, () =>
        resolve(started as Server),
      ) as Server;
    });
    drain.closeConnectionsWhileDraining(server);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    shutdown = drain.createShutdown({
      server,
      drainTimeoutMs: 300,
      interruptGraceMs: 3_000,
      stopIntake: () => {},
      workInProgress: () => runs.activeRunCount() + drain.chatTurnsBeingAdmitted(),
      interruptWork: runs.interruptActiveRuns,
      endStreams: endChatReplays,
      closeResources: async () => {},
      exit: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  afterAll(async () => {
    await provider?.close();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread() {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Gateway stop' })
      .returning();
    return row!.id;
  }
  async function startReply(threadId: string) {
    const reply = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Write 3,000 words' }] }],
      }),
    });
    expect(reply.status).toBe(200);
    return readUntil(reply.body!, (text) => text.includes('part2'));
  }
  async function assistant(threadId: string) {
    const rows = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId));
    return rows.find((row) => row.role === 'assistant')!;
  }

  it('saves a reply cut off by the drain limit as interrupted', async () => {
    const busy = await thread();
    const reading = await startReply(busy);
    await shutdown('SIGTERM');
    const text = await reading.rest();
    expect(text).toContain('part2');
    expect(text).not.toContain('"type":"error"');
    expect(text).not.toContain('"type":"finish"');

    const saved = await assistant(busy);
    expect(saved).toMatchObject({
      status: 'cancelled',
      errorMessage: expect.stringMatching(/interrupted because the server/i),
    });
    expect(JSON.stringify(saved.parts)).toContain('part2');
  }, 15_000);

  it("saves a person's Stop as stopped, with an abort frame rather than an error", async () => {
    const busy = await thread();
    const reading = await startReply(busy);
    const stop = await fetch(`${base}/api/chat/${busy}/stream`, { method: 'DELETE' });
    expect(await stop.json()).toEqual({ cancelled: true });
    const text = await reading.rest();
    expect(text).toContain('"type":"abort"');
    expect(text).not.toContain('"type":"error"');

    const saved = await assistant(busy);
    expect(saved).toMatchObject({ status: 'cancelled', errorMessage: null });
    expect(JSON.stringify(saved.parts)).toContain('part2');
  }, 15_000);
});
