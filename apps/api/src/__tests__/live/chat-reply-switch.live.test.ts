import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDatabase, eq, runMigrations, schema, sql } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';

/**
 * Retried replies through real PostgreSQL, real turn preparation (stopping
 * before any provider call), the real routes and the real migration.
 */
type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', branching: true }));
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
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features')
      return {
        attachments: true,
        temporaryChat: true,
        shareLinks: true,
        branching: state.branching,
      };
    if (key === 'roleFeatures') return { roles: { user: { branching: state.branching } } };
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => ({ get: async () => Buffer.alloc(0) }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/quota/index.js', () => ({
  reserveQuotaForRun: async () => null,
  releaseReservation: async () => {},
  settleReservation: async () => {},
  recordUsage: async () => {},
}));
vi.mock('../../services/chat-streams.js', () => ({
  beginChatRun: async () => 'unavailable',
  abandonChatRun: async () => {},
  unregisterLocalChatRun: () => {},
}));

const available = await livePostgresAvailable();

/** What the provider would receive, after the real SDK conversion. */
async function modelTranscript(started: StartedTurn) {
  return (await convertToModelMessages(started.turn.uiMessages)).map((message) => ({
    role: message.role,
    text:
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }));
}

describe.skipIf(!available)('live reply switching', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('reply_switch');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
    const { chatRoutes } = await import('../../routes/chat.js');
    const { threadRoutes } = await import('../../routes/threads.js');
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
    app.route('/api/threads', threadRoutes);
  });
  beforeEach(() => {
    state.branching = true;
  });
  afterEach(async () => {
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function thread() {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, title: 'Retried chat' })
      .returning();
    return row!;
  }
  async function rows(threadId: string) {
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: owner, name: 'Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
        ...extra,
      },
    );
    runs.add(started.run);
    return started;
  }
  async function retry(threadId: string, promptId: string, text: string) {
    return send(threadId, text, {
      trigger: 'regenerate-message',
      messages: [{ id: promptId, role: 'user', parts: [{ type: 'text', text }] }],
    });
  }
  async function complete(started: StartedTurn, text: string) {
    await pool.db
      .update(schema.message)
      .set({ status: 'complete', parts: [{ type: 'text', text }] })
      .where(eq(schema.message.id, started.run.assistantMessage.id));
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    await releaseRunHandles(started.run, true);
    runs.delete(started.run);
  }
  function activate(threadId: string, messageId: string, user = owner) {
    return app.request(`/api/threads/${threadId}/messages/${messageId}/active`, {
      method: 'PATCH',
      headers: { 'x-test-user': user },
    });
  }
  /** A thread whose only turn was retried once: OLD_REPLY superseded by NEW_REPLY. */
  async function retriedThread() {
    const chat = await thread();
    const first = await send(chat.id, 'Question one');
    await complete(first, 'OLD_REPLY');
    const retried = await retry(chat.id, first.turn.promptMessageId, 'Question one');
    await complete(retried, 'NEW_REPLY');
    return {
      chat,
      prompt: first.turn.promptMessageId,
      oldReply: first.run.assistantMessage.id,
      newReply: retried.run.assistantMessage.id,
    };
  }

  it('sends only the latest reply to a retried turn as context for the next turn', async () => {
    const { chat } = await retriedThread();
    const next = await send(chat.id, 'Question two');
    expect(await modelTranscript(next)).toEqual([
      { role: 'user', text: 'Question one' },
      { role: 'assistant', text: 'NEW_REPLY' },
      { role: 'user', text: 'Question two' },
    ]);
  });

  it('makes a retry the active reply and keeps the replaced one', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    const stored = await rows(chat.id);
    expect(stored.map((row) => [row.id, row.supersededAt === null])).toEqual([
      [prompt, true],
      [oldReply, false],
      [newReply, true],
    ]);
    expect(stored[2]?.parentMessageId).toBe(prompt);
  });

  it('returns the active conversation and every reply to the latest turn', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    const response = await app.request(`/api/chat/${chat.id}/messages`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; parts: unknown }>;
      replies: Array<{ id: string; parts: unknown }>;
    };
    expect(body.messages.map((message) => message.id)).toEqual([prompt, newReply]);
    expect(body.replies.map((reply) => reply.id)).toEqual([oldReply, newReply]);
    expect(body.replies[0]?.parts).toEqual([{ type: 'text', text: 'OLD_REPLY' }]);

    const detail = (await (await app.request(`/api/threads/${chat.id}`)).json()) as {
      messages: Array<{ id: string }>;
    };
    expect(detail.messages.map((message) => message.id)).toEqual([prompt, newReply]);

    // Once the conversation moves on, earlier alternatives are not offered.
    await complete(await send(chat.id, 'Question two'), 'SECOND_REPLY');
    const later = (await (await app.request(`/api/chat/${chat.id}/messages`)).json()) as {
      messages: Array<{ id: string }>;
      replies: unknown[];
    };
    expect(later.messages).toHaveLength(4);
    expect(later.replies).toEqual([]);
  });

  it('switches the active reply, which changes what the next turn sends', async () => {
    const { chat, oldReply, newReply } = await retriedThread();
    const response = await activate(chat.id, oldReply);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeMessageId: oldReply });
    expect((await rows(chat.id)).map((row) => row.supersededAt === null)).toEqual([
      true,
      true,
      false,
    ]);
    // Selecting the reply that is already active changes nothing.
    expect((await activate(chat.id, oldReply)).status).toBe(200);

    const next = await send(chat.id, 'Question two');
    expect(await modelTranscript(next)).toEqual([
      { role: 'user', text: 'Question one' },
      { role: 'assistant', text: 'OLD_REPLY' },
      { role: 'user', text: 'Question two' },
    ]);
    expect(JSON.stringify(next.turn.uiMessages)).not.toContain(newReply);
  });

  it('retries after switching back, keeping every reply in order', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    expect((await activate(chat.id, oldReply)).status).toBe(200);
    const third = await retry(chat.id, prompt, 'Question one');
    // The retry is answered from the turn's own history, never a sibling reply.
    expect(await modelTranscript(third)).toEqual([{ role: 'user', text: 'Question one' }]);
    await complete(third, 'THIRD_REPLY');
    const body = (await (await app.request(`/api/chat/${chat.id}/messages`)).json()) as {
      messages: Array<{ id: string }>;
      replies: Array<{ id: string }>;
    };
    expect(body.replies.map((reply) => reply.id)).toEqual([
      oldReply,
      newReply,
      third.run.assistantMessage.id,
    ]);
    expect(body.messages.map((message) => message.id)).toEqual([
      prompt,
      third.run.assistantMessage.id,
    ]);
  });

  it('refuses to switch or retry any turn but the latest', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    const second = await send(chat.id, 'Question two');
    await complete(second, 'SECOND_REPLY');
    const before = await rows(chat.id);
    for (const id of [oldReply, newReply]) {
      const response = await activate(chat.id, id);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining('Only the latest reply') },
      });
    }
    // A user message is not a reply.
    expect((await activate(chat.id, second.turn.promptMessageId)).status).toBe(422);
    await expect(retry(chat.id, prompt, 'Question one')).rejects.toMatchObject({ status: 422 });
    expect(await rows(chat.id)).toEqual(before);
  });

  it('hides another person’s thread and unknown messages (404)', async () => {
    const { chat, oldReply } = await retriedThread();
    expect((await activate(chat.id, oldReply, stranger)).status).toBe(404);
    expect((await activate(chat.id, randomUUID())).status).toBe(404);
    const other = await thread();
    expect((await activate(other.id, oldReply)).status).toBe(404);
    expect((await rows(chat.id))[1]?.supersededAt).toBeInstanceOf(Date);
  });

  it('refuses to switch while a reply in the thread is generating (409)', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    const generating = await retry(chat.id, prompt, 'Question one');
    const response = await activate(chat.id, oldReply);
    expect(response.status).toBe(409);
    expect((await activate(chat.id, newReply)).status).toBe(409);
    const stored = await rows(chat.id);
    expect(stored.find((row) => row.id === generating.run.assistantMessage.id)?.supersededAt).toBe(
      null,
    );
    expect(stored.filter((row) => row.supersededAt === null)).toHaveLength(2);
  });

  it('needs no branching permission, like retry, while forking still does', async () => {
    state.branching = false;
    const { chat, oldReply, newReply } = await retriedThread();
    expect((await activate(chat.id, oldReply)).status).toBe(200);
    const fork = await app.request(`/api/threads/${chat.id}/forks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: newReply }),
    });
    expect(fork.status).toBe(403);
  });

  it('exports, shares and searches only the active reply', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    await pool.db
      .update(schema.thread)
      .set({ title: 'Export subject' })
      .where(eq(schema.thread.id, chat.id));
    const { exportThreadMarkdown } = await import('../../services/export.js');
    const markdown = await exportThreadMarkdown(chat.id, owner);
    expect(markdown).toContain('NEW_REPLY');
    expect(markdown).not.toContain('OLD_REPLY');

    const { exportArchive } = await import('../../services/portability/export-archive.js');
    const chunks: Uint8Array[] = [];
    for await (const chunk of exportArchive({ id: owner })) chunks.push(chunk);
    const files = unzipSync(Buffer.concat(chunks));
    const exportedFile = (extension: string) =>
      Object.entries(files).find(
        ([name]) => name.startsWith('conversations/export-subject') && name.endsWith(extension),
      )![1];
    const json = exportedFile('.json');
    const exported = JSON.parse(strFromU8(json)) as {
      messages: Array<{ id: string; supersededAt?: unknown }>;
    };
    expect(exported.messages.map((message) => message.id)).toEqual([prompt, newReply]);
    expect(exported.messages[0]).not.toHaveProperty('supersededAt');
    const archiveMarkdown = strFromU8(exportedFile('.md'));
    expect(archiveMarkdown).toContain('NEW_REPLY');
    expect(archiveMarkdown).not.toContain('OLD_REPLY');

    const { createShareLink, getPublicShare } = await import('../../services/share-links.js');
    const live = await createShareLink(chat.id, owner, {});
    const shared = await getPublicShare(live.slug);
    expect(shared.messages.map((message) => message.id)).toEqual([prompt, newReply]);
    // A snapshot through a reply keeps showing it after the owner switches away.
    const snapshot = await createShareLink(chat.id, owner, { upToMessageId: newReply });
    expect((await activate(chat.id, oldReply)).status).toBe(200);
    expect((await getPublicShare(snapshot.slug)).messages.map((message) => message.id)).toEqual([
      prompt,
      newReply,
    ]);
    expect((await getPublicShare(live.slug)).messages.map((message) => message.id)).toEqual([
      prompt,
      oldReply,
    ]);
    const oldSnapshot = await createShareLink(chat.id, owner, { upToMessageId: oldReply });
    expect((await activate(chat.id, newReply)).status).toBe(200);
    expect((await getPublicShare(oldSnapshot.slug)).messages.map((message) => message.id)).toEqual([
      prompt,
      oldReply,
    ]);

    await pool.db
      .update(schema.message)
      .set({ parts: [{ type: 'text', text: 'Superseded zebracorn answer' }] })
      .where(eq(schema.message.id, oldReply));
    await pool.db
      .update(schema.message)
      .set({ parts: [{ type: 'text', text: 'Active unicorn answer' }] })
      .where(eq(schema.message.id, newReply));
    const { searchThreads } = await import('../../services/thread-search.js');
    expect(await searchThreads(owner, 'zebracorn')).toEqual([]);
    const hits = await searchThreads(owner, 'unicorn');
    expect(hits.map((hit) => hit.matches.map((match) => match.messageId))).toEqual([[newReply]]);
  });

  it('forks and edits along the active path', async () => {
    const { chat, prompt, oldReply, newReply } = await retriedThread();
    const second = await send(chat.id, 'Question two');
    await complete(second, 'SECOND_REPLY');
    const { branchFromUserMessage, forkFromMessage } = await import('../../services/threads.js');
    const texts = async (threadId: string) =>
      (await rows(threadId)).map((row) => [
        row.role,
        (row.parts[0] as { text?: string } | undefined)?.text,
        row.supersededAt,
      ]);

    const fork = await forkFromMessage(chat.id, owner, {
      messageId: second.run.assistantMessage.id,
    });
    expect(await texts(fork.id)).toEqual([
      ['user', 'Question one', null],
      ['assistant', 'NEW_REPLY', null],
      ['user', 'Question two', null],
      ['assistant', 'SECOND_REPLY', null],
    ]);
    // Forking at a replaced reply reads as the conversation did then.
    const fromOld = await forkFromMessage(chat.id, owner, { messageId: oldReply });
    expect(await texts(fromOld.id)).toEqual([
      ['user', 'Question one', null],
      ['assistant', 'OLD_REPLY', null],
    ]);
    const fromPrompt = await forkFromMessage(chat.id, owner, { messageId: prompt });
    expect(await texts(fromPrompt.id)).toEqual([['user', 'Question one', null]]);

    const edit = await branchFromUserMessage(chat.id, owner, {
      messageId: second.turn.promptMessageId,
      text: 'Question two, edited',
    });
    expect(await texts(edit.thread.id)).toEqual([
      ['user', 'Question one', null],
      ['assistant', 'NEW_REPLY', null],
      ['user', 'Question two, edited', null],
    ]);
    expect(newReply).not.toBe(oldReply);
  });
});

/**
 * Migration 0025 against rows written before it existed: the column is
 * removed and its journal entry forgotten, history is seeded the way the old
 * code stored retries, and the real migrator applies 0025 again.
 */
describe.skipIf(!available)('live migration 0025 reply backfill', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('reply_backfill');
    organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, organizationId);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('keeps the newest reply of every turn active and supersedes the rest', async () => {
    await live.db.execute(sql`alter table message drop column superseded_at`);
    // The migrator only applies migrations newer than the latest recorded one,
    // so forget 0025 and everything after it. Later migrations are written to
    // be re-runnable (IF NOT EXISTS), so applying them again is harmless.
    const journal = JSON.parse(
      readFileSync(
        new URL('../../../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string; when: number }> };
    const reply = journal.entries.find((entry) => entry.tag === '0025_reply_alternates');
    if (!reply) throw new Error('Migration 0025 is missing from the journal');
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where created_at >= ${reply.when}::bigint`);
    const ids = new Map<string, string>();
    async function seed(label: string, rows: Array<[name: string, role: string, at?: number]>) {
      const [thread] = await live.db.execute<{ id: string }>(sql`
        insert into thread (organization_id, user_id, title)
        values (${organizationId}, ${userId}, ${label}) returning id`);
      for (const [position, [name, role, at]] of rows.entries()) {
        const [row] = await live.db.execute<{ id: string }>(sql`
          insert into message (thread_id, user_id, role, parts, position, created_at)
          values (${thread!.id}, ${userId}, ${role}, '[]'::jsonb, ${position},
                  ${new Date(Date.UTC(2026, 0, 1, 0, 0, at ?? position)).toISOString()}::timestamptz)
          returning id`);
        ids.set(name, row!.id);
      }
    }
    await seed('Two retried turns', [
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['a1-retry', 'assistant'],
      ['u2', 'user'],
      ['a2', 'assistant'],
      ['a2-retry', 'assistant'],
      // Position, not creation time, decides which reply is newest.
      ['a2-retry-2', 'assistant', 0],
    ]);
    await seed('Plain', [
      ['p-u1', 'user'],
      ['p-a1', 'assistant'],
      ['p-u2', 'user'],
      ['p-a2', 'assistant'],
      ['p-u3', 'user'],
    ]);
    await seed('Orphans', [
      ['o-a0', 'assistant'],
      ['o-a1', 'assistant'],
      ['o-s', 'system'],
      ['o-u1', 'user'],
      ['o-a2', 'assistant'],
    ]);

    await runMigrations(live.db);

    const stored = await live.db.execute<{ id: string; superseded: boolean }>(
      sql`select id, superseded_at is not null as superseded from message`,
    );
    const superseded = new Set(stored.filter((row) => row.superseded).map((row) => row.id));
    const expected = ['a1', 'a2', 'a2-retry'];
    for (const [name, id] of ids) expect(superseded.has(id), name).toBe(expected.includes(name));
    expect(superseded.size).toBe(expected.length);
  });
});
