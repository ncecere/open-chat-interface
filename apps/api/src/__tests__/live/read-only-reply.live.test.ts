import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createDatabase, eq, schema } from '@oci/db';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Read-only maintenance mode (v0.11 design, section 9) and a reply being
 * written when it is switched on, through a real HTTP server, PostgreSQL,
 * Redis and the chat routes: the reply admitted before the switch finishes
 * and is saved complete; a turn sent after it is refused with 423 before
 * anything is stored; Stop keeps working.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  model: null as unknown,
  maintenance: {} as Record<string, unknown>,
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
    key === 'maintenance'
      ? state.maintenance
      : key === 'features'
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

const usage = { inputTokens: { total: 4 }, outputTokens: { total: 6 } };
/** A model that writes `deltas` text pieces `everyMs` apart, then finishes. */
function model({ deltas = 8, everyMs = 100 } = {}) {
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

describe.skipIf(!available)('live read-only mode and a reply in progress', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    live = await createLiveDatabase('read_only_reply');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { readOnlyGuard } = await import('../../middleware/read-only.js');
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    // As in routes/index.ts: the guard before anything else.
    app.use('/api/*', readOnlyGuard);
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
      const started = serve({ fetch: app.fetch, port: 0 }, () =>
        resolve(started as Server),
      ) as Server;
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    const { closeChatStreams } = await import('../../services/chat-streams.js');
    await closeChatStreams();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread() {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner, title: 'Read-only' })
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
  const messages = (threadId: string) =>
    pool.db.select().from(schema.message).where(eq(schema.message.threadId, threadId));

  it('finishes the reply admitted before the switch and refuses the next turn', async () => {
    const busy = await thread();
    const other = await thread();
    model({ deltas: 8, everyMs: 100 });
    const reply = await send(busy);
    expect(reply.status).toBe(200);
    const reading = await readUntil(reply.body!, (text) => text.includes('piece 1'));

    // Switched on while the reply is being written.
    state.maintenance = { readOnly: true, reason: 'Upgrade' };
    const refused = await send(other, 'Sent while read-only');
    expect(refused.status).toBe(423);
    expect(await refused.json()).toMatchObject({ error: { code: 'READ_ONLY' } });
    // Refused before it was read: nothing was stored.
    expect(await messages(other)).toHaveLength(0);

    const text = await reading.rest();
    expect(text).toContain('piece 7');
    expect(text).toContain('"type":"finish"');
    await vi.waitFor(async () => {
      const [assistant] = (await messages(busy)).filter((row) => row.role === 'assistant');
      expect(assistant).toMatchObject({ status: 'complete', errorMessage: null });
    });
    state.maintenance = {};
  }, 15_000);

  it('lets a person stop their reply while read-only', async () => {
    const busy = await thread();
    model({ deltas: 200, everyMs: 50 });
    const reply = await send(busy);
    expect(reply.status).toBe(200);
    const reading = await readUntil(reply.body!, (text) => text.includes('piece 1'));
    state.maintenance = { readOnly: true };
    const stop = await fetch(`${base}/api/chat/${busy}/stream`, { method: 'DELETE' });
    expect(stop.status).not.toBe(423);
    expect(stop.ok).toBe(true);
    await reading.rest();
    await vi.waitFor(async () => {
      const [assistant] = (await messages(busy)).filter((row) => row.role === 'assistant');
      expect(assistant?.status).toBe('cancelled');
    });
    state.maintenance = {};
  }, 15_000);
});
