import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admissionApp,
  admissionHelpers,
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
 * This file: rejected and failed admissions leave nothing behind; checks under the lock.
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

  it.each(['quota', 'slot', 'preparation'] as const)(
    'leaves no prompt, claim, title or allocation after %s rejection',
    async (failure) => {
      const chat = await thread();
      const file = await attachment();
      if (failure === 'quota') state.quotaDenied = true;
      if (failure === 'slot') state.slotDenied = true;
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
    expect(rows[1]?.supersededAt).toBeInstanceOf(Date);
    expect(rows[2]?.parentMessageId).toBe(rows[0]?.id);
    expect(rows[2]?.supersededAt).toBeNull();
    expect(state.started[1]!.turn.uiMessages).toHaveLength(1);
    expect(JSON.stringify(state.started[1]!.turn.uiMessages)).toContain('original');
  });
});
