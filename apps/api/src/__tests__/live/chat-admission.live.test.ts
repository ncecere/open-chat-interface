import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
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
import type { PreparedTurn } from '../../services/chat/prepare-turn.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { ChatStreamStore } from '../../services/chat-streams.js';

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
    beginChatRun: async (identity: { runId: string; threadId: string; userId: string }) => {
      state.identities.push(identity);
      return state.mode === 'available' ? state.store!.begin(identity) : state.mode;
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
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const redisAvailable = await (async () => {
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
})();
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.skipIf(!available)('live atomic chat admission', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let redis: Redis;
  let app: Hono<AppBindings>;
  beforeAll(async () => {
    live = await createLiveDatabase('chat_admission');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    const { ChatStreamStore } = await import('../../services/chat-streams.js');
    if (redisAvailable) {
      redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
      redis.on('error', () => {});
      await redis.ping();
      state.store = new ChatStreamStore(redis, 60);
    }
    const { chatRoutes } = await import('../../routes/chat.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: c.req.header('x-test-user') ?? owner,
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
  async function thread(temporary = false) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({
        userId: owner,
        organizationId: state.organizationId,
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
    userId = owner,
  ) {
    return app.request('/api/chat', {
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
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function attachment() {
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: owner,
        filename: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        storageKey: randomUUID(),
        extractedText: 'text',
      })
      .returning();
    return row!;
  }

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

  it.each(['quota', 'slot', 'redis', 'preparation'] as const)(
    'leaves no prompt, claim, title or allocation after %s rejection',
    async (failure) => {
      const chat = await thread();
      const file = await attachment();
      if (failure === 'quota') state.quotaDenied = true;
      if (failure === 'slot') state.slotDenied = true;
      if (failure === 'redis') state.mode = 'conflict';
      if (failure === 'preparation')
        state.hook = async () => {
          throw new Error('Injected preparation failure');
        };
      expect(
        (await post(chat.id, 'rejected', { attachmentIds: [file.id] })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(await messages(chat.id)).toHaveLength(0);
      const [stored] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(stored?.messageId).toBeNull();
      const [unchanged] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, chat.id));
      expect(unchanged?.title).toBe('New Chat');
      expect(state.started).toHaveLength(0);
    },
  );

  it('releases admission resources if the initial claim insert fails', async () => {
    const chat = await thread();
    await pool.db.execute(
      sql`alter table message add constraint injected_message_failure check (role <> 'assistant') not valid`,
    );
    const preparation = vi.fn(async () => {});
    state.hook = preparation;
    expect((await post(chat.id, 'not stored')).status).toBe(500);
    expect(await messages(chat.id)).toHaveLength(0);
    expect(preparation).not.toHaveBeenCalled();
    expect(state.released).toBe(1);
  });

  it.each(['foreign', 'deleted'] as const)(
    'rechecks %s attachments under the transaction lock',
    async (kind) => {
      const chat = await thread();
      const file = await attachment();
      await pool.db
        .update(schema.attachment)
        .set(kind === 'foreign' ? { userId: stranger } : { deletedAt: new Date() })
        .where(eq(schema.attachment.id, file.id));
      expect((await post(chat.id, 'not stored', { attachmentIds: [file.id] })).status).toBe(422);
      expect(await messages(chat.id)).toHaveLength(0);
      const [stored] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(stored?.messageId).toBeNull();
    },
  );

  it.skipIf(!redisAvailable)(
    'does not clear an existing Redis owner when its own provisional claim is rejected',
    async () => {
      const chat = await thread();
      state.mode = 'available';
      const identity = { threadId: chat.id, userId: owner, runId: randomUUID() };
      state.identities.push(identity);
      await state.store!.begin(identity);
      expect((await post(chat.id, 'rejected')).status).toBe(409);
      expect(await messages(chat.id)).toHaveLength(0);
      expect(await state.store!.activeRun(chat.id, owner)).toEqual(identity);
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

  it('does not hold a transaction connection while preparing the model input', async () => {
    await pool.sql.end({ timeout: 1 });
    pool = createDatabase(live.connectionString, { max: 1 });
    state.db = pool.db;
    const chats = [await thread(), await thread()];
    state.hook = async () => {
      await pool.db.execute(sql`select 1`);
    };
    const results = await Promise.all(chats.map((chat) => post(chat.id, 'accepted')));
    expect(results.map((response) => response.status)).toEqual([200, 200]);
  });

  it('rolls back user, attachment and title writes if completing the assistant placeholder fails', async () => {
    const chat = await thread();
    const file = await attachment();
    await pool.db.execute(
      sql`alter table message add constraint injected_message_failure check (role <> 'assistant' or parent_message_id is null) not valid`,
    );
    expect((await post(chat.id, 'rejected', { attachmentIds: [file.id] })).status).toBe(500);
    expect(await messages(chat.id)).toHaveLength(0);
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored?.messageId).toBeNull();
    const [unchanged] = await pool.db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.id, chat.id));
    expect(unchanged?.title).toBe('New Chat');
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

  it('never claims a stranger thread', async () => {
    const chat = await thread();
    expect((await post(chat.id, 'unauthorized', {}, stranger)).status).toBe(404);
    expect(await messages(chat.id)).toHaveLength(0);
  });

  it.each(['delete', 'expire'] as const)(
    'revalidates the thread before persisting when it is %s during preparation',
    async (change) => {
      const chat = await thread(change === 'expire');
      state.hook = async () => {
        await pool.db
          .update(schema.thread)
          .set(change === 'expire' ? { expiresAt: new Date(0) } : { deletedAt: new Date() })
          .where(eq(schema.thread.id, chat.id));
      };
      expect((await post(chat.id, 'not stored')).status).toBe(404);
      expect(await messages(chat.id)).toHaveLength(0);
      expect(state.started).toHaveLength(0);
    },
  );

  it('regenerates without persisting another user message or changing the original reply', async () => {
    const chat = await thread();
    expect((await post(chat.id, 'original')).status).toBe(200);
    const original = state.started[0]!;
    await pool.db
      .update(schema.message)
      .set({ status: 'complete', parts: [{ type: 'text', text: 'old reply' }] })
      .where(eq(schema.message.id, original.run.assistantMessage.id));
    expect(
      (
        await post(chat.id, 'original', {
          trigger: 'regenerate-message',
          messages: [
            {
              id: original.turn.promptMessageId,
              role: 'user',
              parts: [{ type: 'text', text: 'original' }],
            },
          ],
        })
      ).status,
    ).toBe(200);
    const rows = await messages(chat.id);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(rows[1]?.parts).toEqual([{ type: 'text', text: 'old reply' }]);
    expect(rows[2]?.parentMessageId).toBe(rows[0]?.id);
    expect(state.started[1]!.turn.uiMessages).toHaveLength(1);
    expect(JSON.stringify(state.started[1]!.turn.uiMessages)).toContain('original');
  });
});
