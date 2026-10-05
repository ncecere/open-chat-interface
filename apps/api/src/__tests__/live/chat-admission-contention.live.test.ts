import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admissionApp,
  admissionHelpers,
  gate,
  redisAvailableFor,
  redisUrl,
} from '../../../test/chat-admission.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';
import type { PreparedTurn } from '../../services/chat/prepare-turn.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { ChatStreamStore } from '../../services/chat-streams.js';

/**
 * Atomic chat admission through real PostgreSQL (and Redis when it answers),
 * stopping at provider invocation.
 *
 * This file: competing turns, Redis and durable ownership of a running reply.
 * The shared helpers are in test/chat-admission.fixtures.ts; the other
 * chat-admission-*.live.test.ts file covers the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  mode: 'unavailable' as 'available' | 'unavailable' | 'conflict',
  store: null as ChatStreamStore | null,
  hook: null as (() => Promise<void>) | null,
  quotaDenied: false,
  slotDenied: false,
  released: 0,
  started: [] as Array<{ turn: PreparedTurn; run: AcquiredRun }>,
  identities: [] as Array<{ runId: string; threadId: string; userId: string }>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    languageModel: {},
  }),
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => {
    await state.hook?.();
    return '';
  },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({ temporaryChat: true }),
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () =>
    state.slotDenied
      ? null
      : {
          release: async () => {
            state.released++;
          },
        },
}));
vi.mock('../../services/quota/index.js', async () => {
  const { forbidden } = await import('../../lib/errors.js');
  return {
    reserveQuotaForRun: async () => {
      if (state.quotaDenied) throw forbidden('Quota denied');
      return null;
    },
    releaseReservation: async () => {},
    settleReservation: async () => {},
    recordUsage: async () => {},
  };
});
vi.mock('../../services/attachments/index.js', () => ({
  assertAttachmentUseAllowed: async () => {},
}));
// Keep preflight/file reads stubbed in admission tests so the final transaction
// (not the earlier inspection) is the authority exercised by invalid-file cases.
vi.mock('../../services/chat/attachment-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chat/attachment-context.js')>();
  return {
    ...actual,
    inspectIncomingAttachments: async (ids: string[]) =>
      [...new Set(ids)].map((id) => ({
        id,
        messageId: null,
        mimeType: 'text/plain',
        sizeBytes: 4,
        textBytes: 12,
        filenameBytes: 8,
        deletedAt: null,
      })),
    materializeAttachments: async (files: Array<{ id: string }>) =>
      new Map(
        files.map(({ id }) => [
          id,
          {
            id,
            filename: 'note.txt',
            mimeType: 'text/plain',
            extractedText: 'fixture text',
            bytes: null,
          },
        ]),
      ),
  };
});
vi.mock('../../services/chat-streams.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chat-streams.js')>();
  return {
    ...actual,
    beginChatRun: async (...args: Parameters<typeof actual.beginChatRun>) => {
      state.identities.push(args[0]);
      return state.mode === 'available' ? state.store!.begin(...args) : state.mode;
    },
    abandonChatRun: async (identity: { runId: string; threadId: string; userId: string }) => {
      await state.store?.abandon(identity);
    },
  };
});
// Stop precisely at provider invocation. No real model requests; persistence,
// admission, preparation and (when enabled) Redis ownership are real.
vi.mock('../../services/chat/stream-response.js', () => ({
  streamResponse: async (turn: PreparedTurn, run: AcquiredRun) => {
    state.started.push({ turn, run });
    return new Response('accepted');
  },
}));
const available = await livePostgresAvailable();
const redisAvailable = await redisAvailableFor(available);

describe.skipIf(!available)('live atomic chat admission', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let redis: Redis;
  let app: Hono<AppBindings>;
  beforeAll(async () => {
    live = await createLiveDatabase('chat_admission');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    const { ChatStreamStore } = await import('../../services/chat-streams.js');
    if (redisAvailable) {
      redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
      redis.on('error', () => {});
      await redis.ping();
      state.store = new ChatStreamStore(redis, 60);
    }
    app = await admissionApp(state.organizationId, owner);
  });
  beforeEach(() => {
    state.mode = 'unavailable';
    state.hook = null;
    state.started = [];
    state.quotaDenied = false;
    state.slotDenied = false;
    state.released = 0;
  });
  afterEach(async () => {
    await pool.db.execute(
      sql`alter table message drop constraint if exists injected_message_failure`,
    );
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    for (const identity of state.identities.splice(0)) {
      if (!redisAvailable) continue;
      await state.store?.abandon(identity);
      await redis.del(
        `oci:chat-stream:run:${identity.runId}:metadata`,
        `oci:chat-stream:run:${identity.runId}:events`,
      );
    }
  });
  afterAll(async () => {
    redis?.disconnect();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });
  const { thread, post, messages, attachment } = admissionHelpers({
    get pool() {
      return pool;
    },
    get app() {
      return app;
    },
    get owner() {
      return owner;
    },
    get organizationId() {
      return state.organizationId;
    },
  });

  it.for(['available', 'unavailable'] as const)(
    'rejects a competing turn before history or writes with Redis %s',
    async (mode, context) => {
      if (mode === 'available' && !redisAvailable) return context.skip();
      state.mode = mode;
      const chat = await thread();
      const file = await attachment();
      const entered = gate();
      const finish = gate();
      let calls = 0;
      state.hook = async () => {
        if (++calls === 1) {
          entered.open();
          await finish.promise;
        }
      };
      const winner = post(chat.id, 'winner');
      try {
        await entered.promise;
        const loser = await post(chat.id, 'loser', { attachmentIds: [file.id] });
        expect(loser.status).toBe(409);
        expect(calls).toBe(1);
        const [stillAvailable] = await pool.db
          .select()
          .from(schema.attachment)
          .where(eq(schema.attachment.id, file.id));
        expect(stillAvailable?.messageId).toBeNull();
        expect(JSON.stringify(await messages(chat.id))).not.toContain('loser');
      } finally {
        finish.open();
      }
      expect((await winner).status).toBe(200);
      expect(state.started).toHaveLength(1);
      expect(state.started[0]!.turn.uiMessages).toHaveLength(1);
      expect(JSON.stringify(state.started[0]!.turn.uiMessages)).toContain('winner');
      expect((await messages(chat.id)).map((row) => [row.role, row.position])).toEqual([
        ['user', 0],
        ['assistant', 1],
      ]);
    },
  );

  it('admits exactly one of simultaneous fallback requests', async () => {
    const chat = await thread();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => post(chat.id, `request-${index}`)),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(5);
    expect(state.started).toHaveLength(1);
    expect(await messages(chat.id)).toHaveLength(2);
  });

  it.skipIf(!redisAvailable)(
    'coordinates requests across a Redis availability change',
    async () => {
      const chat = await thread();
      expect((await post(chat.id, 'first')).status).toBe(200);
      state.mode = 'available';
      expect((await post(chat.id, 'second')).status).toBe(409);
      expect(state.started).toHaveLength(1);
    },
  );

  it.skipIf(!redisAvailable)(
    'supersedes terminal-run cache metadata only after durable admission',
    async () => {
      const chat = await thread();
      state.mode = 'available';
      expect((await post(chat.id, 'first')).status).toBe(200);
      const first = state.started[0]!.run.runIdentity;
      // Real durable completion without Redis finalization; no model inference.
      await pool.db
        .update(schema.message)
        .set({ status: 'complete' })
        .where(eq(schema.message.id, first.runId));
      expect(await state.store!.activeRun(chat.id, owner)).toEqual(first);
      expect((await post(chat.id, 'second')).status).toBe(200);
      const second = state.started[1]!.run.runIdentity;
      expect(state.started[1]!.run.persistence).toBe('available');
      expect(await state.store!.activeRun(chat.id, owner)).toEqual(second);
      await state.store!.finalize(first, { status: 'complete' });
      expect(await state.store!.activeRun(chat.id, owner)).toEqual(second);
      expect((await post(chat.id, 'third')).status).toBe(409);
      expect(state.started).toHaveLength(2);
      expect(await messages(chat.id)).toHaveLength(4);
    },
  );

  it('keeps a durable claim when a cache-only conflict is reported', async () => {
    const chat = await thread();
    state.mode = 'conflict';
    expect((await post(chat.id, 'accepted without cache')).status).toBe(200);
    expect(state.started).toHaveLength(1);
    expect(state.started[0]!.run.persistence).toBe('unavailable');
    expect(await messages(chat.id)).toHaveLength(2);
    expect(state.released).toBe(0);
  });

  it.skipIf(!redisAvailable)(
    'does not clear a durable/cache owner when a new claim is rejected',
    async () => {
      const chat = await thread();
      state.mode = 'available';
      const identity = { threadId: chat.id, userId: owner, runId: randomUUID() };
      state.identities.push(identity);
      await state.store!.begin(identity);
      await pool.db.insert(schema.message).values({
        id: identity.runId,
        threadId: chat.id,
        userId: owner,
        role: 'assistant',
        status: 'streaming',
        parts: [],
      });
      expect((await post(chat.id, 'rejected')).status).toBe(409);
      expect(await messages(chat.id)).toEqual([
        expect.objectContaining({ id: identity.runId, status: 'streaming' }),
      ]);
      expect(await state.store!.activeRun(chat.id, owner)).toEqual(identity);
      expect(state.started).toHaveLength(0);
    },
  );

  it.skipIf(!redisAvailable)('releases its own Redis claim after failed preparation', async () => {
    const chat = await thread();
    state.mode = 'available';
    state.hook = async () => {
      throw new Error('Injected failure');
    };
    expect((await post(chat.id, 'rejected')).status).toBe(500);
    expect(await messages(chat.id)).toHaveLength(0);
    expect(await state.store!.activeRun(chat.id, owner)).toBeNull();
    state.hook = null;
    expect((await post(chat.id, 'retry')).status).toBe(200);
  });

  it('serializes reuse of one upload across different threads', async () => {
    const one = await thread();
    const two = await thread();
    const file = await attachment();
    const barrier = gate();
    let arrived = 0;
    state.hook = async () => {
      if (++arrived === 2) barrier.open();
      await barrier.promise;
    };
    const responses = await Promise.all([
      post(one.id, 'one', { attachmentIds: [file.id] }),
      post(two.id, 'two', { attachmentIds: [file.id] }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(state.started).toHaveLength(1);
    expect((await messages(one.id)).length + (await messages(two.id)).length).toBe(2);
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored?.messageId).toBe(state.started[0]!.turn.promptMessageId);
  });

  it('does not steal a still-streaming run merely because it is older than 15 minutes', async () => {
    const chat = await thread();
    await pool.db.insert(schema.message).values({
      threadId: chat.id,
      userId: owner,
      role: 'assistant',
      parts: [],
      position: 0,
      status: 'streaming',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    expect((await post(chat.id, 'no takeover')).status).toBe(409);
    expect(await messages(chat.id)).toHaveLength(1);
  });
});
