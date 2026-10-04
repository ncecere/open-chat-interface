import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createDatabase, eq, schema } from '@oci/db';
import { MockLanguageModelV4 } from 'ai/test';
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
import type { AppBindings } from '../../middleware/context.js';

/**
 * Draining on shutdown (v0.11 design, item 13) through a real HTTP server,
 * PostgreSQL, Redis and the chat routes, with the signal handler server.ts
 * installs. Before v0.11 a stopping replica kept taking new turns over its
 * proxy's keep-alive connections, reported ready, and its replies ended with
 * the process.
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
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));

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

const usage = { inputTokens: { total: 4 }, outputTokens: { total: 6 } };
/**
 * A model that writes `deltas` text pieces `everyMs` apart, then finishes; with
 * `hang`, it stops after the first piece and waits until the run is aborted.
 */
function model({ deltas = 5, everyMs = 80, hang = false } = {}) {
  state.model = new MockLanguageModelV4({
    doStream: (async (options: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          options.abortSignal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
          let sent = 0;
          const next = () => {
            if (options.abortSignal?.aborted) return;
            controller.enqueue({ type: 'text-delta', id: 't', delta: `piece ${sent} ` });
            sent++;
            if (hang) return;
            if (sent < deltas) {
              setTimeout(next, everyMs);
              return;
            }
            controller.enqueue({ type: 'text-end', id: 't' });
            controller.enqueue({
              type: 'finish',
              usage,
              finishReason: { unified: 'stop', raw: 'stop' },
            });
            controller.close();
          };
          setTimeout(next, everyMs);
        },
      }),
    })) as never,
  });
}

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
    text,
    rest: async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return text;
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe.skipIf(!available)('live drain on shutdown', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const redis = new Redis(redisUrl, redisOptions);
  let owner: string;
  let server: Server;
  let base: string;
  let exits: number[];
  let closed: number;
  let shutdown: (signal: string) => Promise<void>;

  beforeAll(async () => {
    live = await createLiveDatabase('shutdown_drain');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    await redis.connect();
  });
  /** A server on a free port with server.ts's drain wiring and a fake exit. */
  async function setup(drainTimeoutMs: number) {
    const drain = await import('../../lib/drain.js');
    const runs = await import('../../services/chat/active-runs.js');
    drain.resetDrainForTests();
    runs.resetActiveRunsForTests();
    const { chatRoutes } = await import('../../routes/chat.js');
    const { healthRoutes } = await import('../../routes/health.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { endChatReplays } = await import('../../services/chat-streams.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api/health', healthRoutes);
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
    exits = [];
    closed = 0;
    shutdown = drain.createShutdown({
      server,
      drainTimeoutMs,
      interruptGraceMs: 3_000,
      stopIntake: () => {},
      workInProgress: () => runs.activeRunCount() + drain.chatTurnsBeingAdmitted(),
      interruptWork: runs.interruptActiveRuns,
      endStreams: endChatReplays,
      closeResources: async () => {
        closed++;
      },
      exit: (code) => exits.push(code),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
  }
  async function stopServer() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  /** The same setup with another drain limit. */
  async function restart(drainTimeoutMs: number) {
    await stopServer();
    await setup(drainTimeoutMs);
  }
  beforeEach(() => setup(5_000));
  afterEach(() => stopServer());
  afterAll(async () => {
    redis.disconnect();
    const { sharedRedis } = await import('../../services/chat-streams.js');
    (await sharedRedis())?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread() {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Drain' })
      .returning();
    return row!.id;
  }
  function send(threadId: string, text = 'Hello') {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
      }),
    });
  }
  async function messages(threadId: string) {
    return pool.db.select().from(schema.message).where(eq(schema.message.threadId, threadId));
  }

  it('reports not-ready, refuses new turns before storing them, and lets a reply finish', async () => {
    const busy = await thread();
    const other = await thread();
    model({ deltas: 8, everyMs: 100 });
    const reply = await send(busy);
    expect(reply.status).toBe(200);
    const reading = await readUntil(reply.body!, (text) => text.includes('piece 0'));
    const started = Date.now();
    const done = shutdown('SIGTERM');

    const ready = await fetch(`${base}/api/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: 'draining',
      reason: expect.stringContaining('SIGTERM'),
    });
    expect((await fetch(`${base}/api/health/live`)).status).toBe(200);

    const refused = await send(other, 'Sent during the drain');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(refused.headers.get('connection')).toBe('close');
    expect(refused.headers.get('x-oci-draining')).toBe('1');
    expect(await refused.json()).toMatchObject({ error: { message: /restarting/ } });
    const approval = await fetch(`${base}/api/chat/${other}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(approval.status).toBe(503);
    // Refused before it was read: nothing was stored, so sending it again is safe.
    expect(await messages(other)).toHaveLength(0);

    // Other requests are answered, on connections that then close.
    const history = await fetch(`${base}/api/chat/${busy}/messages`);
    expect(history.status).toBe(200);
    expect(history.headers.get('connection')).toBe('close');

    const text = await reading.rest();
    expect(text).toContain('"type":"finish"');
    await done;
    expect(exits).toEqual([0]);
    expect(closed).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.listening).toBe(false);
    const [assistant] = (await messages(busy)).filter((row) => row.role === 'assistant');
    expect(assistant).toMatchObject({ status: 'complete', errorMessage: null });
  }, 15_000);

  it('past the limit saves each reply as interrupted and ends its readers cleanly', async () => {
    await restart(300);
    const busy = await thread();
    model({ hang: true });
    const reply = await send(busy);
    const runId = reply.headers.get('X-OCI-Chat-Run-Id')!;
    const reading = await readUntil(reply.body!, (text) => text.includes('piece 0'));
    // Another client resuming the same reply through this replica.
    const resumed = await fetch(`${base}/api/chat/${busy}/stream`);
    expect(resumed.status).toBe(200);
    const resumedText = resumed.text();

    const started = Date.now();
    await shutdown('SIGTERM');
    expect(exits).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(300 + 3_000);

    const live = await reading.rest();
    expect(live).toContain('piece 0');
    expect(live).not.toContain('"type":"finish"');
    const replayed = await resumedText;
    expect(replayed).toContain('piece 0');
    expect(replayed).not.toContain('Live replay is no longer available');

    const [assistant] = (await messages(busy)).filter((row) => row.role === 'assistant');
    expect(assistant).toMatchObject({
      id: runId,
      status: 'cancelled',
      errorMessage: expect.stringMatching(/interrupted/i),
    });
    expect(JSON.stringify(assistant!.parts)).toContain('piece 0');
    expect(await redis.hget(`oci:chat-stream:run:${runId}:metadata`, 'status')).toBe('cancelled');
    const [event] = await pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.id, runId));
    expect(event).toMatchObject({ pending: false });
  }, 15_000);

  it('exits at once on a second signal', async () => {
    await restart(1_000);
    const busy = await thread();
    model({ hang: true });
    const reply = await send(busy);
    const reading = await readUntil(reply.body!, (text) => text.includes('piece 0'));
    const done = shutdown('SIGTERM');
    void shutdown('SIGINT');
    expect(exits).toEqual([1]);
    await done;
    await reading.rest();
    expect(exits).toEqual([1, 0]);
  }, 15_000);

  it('starts no background job while draining', async () => {
    const { beginDrain } = await import('../../lib/drain.js');
    const { runExclusively, runningJobCount } = await import('../../services/jobs/runner.js');
    beginDrain('SIGTERM');
    const run = vi.fn(async () => 1);
    expect(await runExclusively({ name: 'test.drain', intervalMs: 1_000, run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(runningJobCount()).toBe(0);
  });
});
