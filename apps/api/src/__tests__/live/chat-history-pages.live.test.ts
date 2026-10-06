import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema } from '@oci/db';
import { CHAT_HISTORY_PAGE_SIZE, type ChatHistoryPage } from '@oci/shared';
import { Hono } from 'hono';
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
 * Long conversations in pages (v0.11, item 21) through real PostgreSQL and the
 * real routes: the latest page first, older and newer pages by cursor, a
 * window around a search result, retried replies, branches, and cursors that
 * stay put while new messages arrive.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features')
      return { attachments: true, temporaryChat: true, shareLinks: true, branching: true };
    if (key === 'roleFeatures') return { roles: { user: { branching: true } } };
    throw new Error(`Unexpected setting: ${key}`);
  },
}));

const available = await livePostgresAvailable();

interface Wire {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string }>;
}
interface PageBody {
  messages: Wire[];
  replies: Wire[];
  page?: ChatHistoryPage;
}
const textOf = (message: Wire) => message.parts[0]?.text ?? '';

describe.skipIf(!available)('live conversation pages', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('history_pages');
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
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  /** A conversation of `turns` question/answer pairs, texts `q<n>` and `a<n>`. */
  async function conversation(turns: number, start = 0) {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, title: 'Long chat' })
      .returning();
    await append(thread!.id, turns, start);
    return thread!.id;
  }
  async function append(threadId: string, turns: number, start: number) {
    if (turns === 0) return;
    const base = Date.UTC(2026, 0, 1);
    const rows: (typeof schema.message.$inferInsert)[] = [];
    for (let turn = start; turn < start + turns; turn++) {
      const prompt = randomUUID();
      rows.push({
        id: prompt,
        threadId,
        userId: owner,
        role: 'user',
        position: turn * 2,
        parts: [{ type: 'text', text: `q${turn}` }],
        status: 'complete',
        createdAt: new Date(base + turn * 2_000),
      });
      rows.push({
        threadId,
        userId: owner,
        role: 'assistant',
        position: turn * 2 + 1,
        parentMessageId: prompt,
        parts: [{ type: 'text', text: `a${turn}` }],
        status: 'complete',
        createdAt: new Date(base + turn * 2_000 + 1_000),
      });
    }
    await pool.db.insert(schema.message).values(rows);
  }
  async function get(threadId: string, query = '', user = owner) {
    return app.request(`/api/chat/${threadId}/messages${query}`, {
      headers: { 'x-test-user': user },
    });
  }
  async function page(threadId: string, query: string): Promise<PageBody> {
    const response = await get(threadId, query);
    expect(response.status).toBe(200);
    return (await response.json()) as PageBody;
  }
  const texts = (body: PageBody) => body.messages.map(textOf);

  it('keeps the whole-conversation shape without paging parameters', async () => {
    const id = await conversation(3);
    const body = (await (await get(id)).json()) as PageBody & Record<string, unknown>;
    expect(texts(body)).toEqual(['q0', 'a0', 'q1', 'a1', 'q2', 'a2']);
    expect(body.replies).toEqual([]);
    expect('page' in body).toBe(false);
  });

  it('serves the latest page first and every older page exactly once', async () => {
    const id = await conversation(130);
    const full = texts((await (await get(id)).json()) as PageBody);
    const latest = await page(id, '?limit=100');
    expect(latest.messages).toHaveLength(CHAT_HISTORY_PAGE_SIZE);
    expect(texts(latest)).toEqual(full.slice(-100));
    expect(latest.page).toEqual({
      olderCursor: latest.messages[0]!.id,
      newerCursor: null,
      total: 260,
    });

    const seen = [...latest.messages];
    let cursor = latest.page!.olderCursor;
    let pages = 0;
    while (cursor) {
      const older = await page(id, `?limit=70&before=${cursor}`);
      expect(older.replies).toEqual([]);
      expect(older.page!.newerCursor).toBe(older.messages.at(-1)!.id);
      seen.unshift(...older.messages);
      cursor = older.page!.olderCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen.map(textOf)).toEqual(full);
    expect(new Set(seen.map((message) => message.id)).size).toBe(260);
    // The default page size applies to any paged request.
    expect((await page(id, `?before=${latest.page!.olderCursor}`)).messages).toHaveLength(100);
  });

  it('orders ties in position as the whole conversation does', async () => {
    const id = await conversation(0);
    const base = Date.UTC(2026, 0, 1);
    // Imported conversations can repeat a position; creation time then id decide.
    await pool.db.insert(schema.message).values(
      ['first', 'second', 'third', 'fourth'].map((text, index) => ({
        threadId: id,
        userId: owner,
        role: index % 2 ? ('assistant' as const) : ('user' as const),
        position: 0,
        parts: [{ type: 'text', text }],
        status: 'complete' as const,
        createdAt: new Date(base + index),
      })),
    );
    const full = texts((await (await get(id)).json()) as PageBody);
    const last = await page(id, '?limit=2');
    const before = await page(id, `?limit=2&before=${last.page!.olderCursor}`);
    expect([...texts(before), ...texts(last)]).toEqual(full);
    expect(full).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('keeps cursors where they were while new messages arrive', async () => {
    const id = await conversation(20);
    const latest = await page(id, '?limit=10');
    const olderBefore = await page(id, `?limit=10&before=${latest.page!.olderCursor}`);
    await append(id, 5, 20);
    const olderAfter = await page(id, `?limit=10&before=${latest.page!.olderCursor}`);
    expect(texts(olderAfter)).toEqual(texts(olderBefore));
    expect(olderAfter.page!.total).toBe(50);
    // The latest page has moved on; continuing after the old latest page reaches the new end.
    const newer = await page(id, `?limit=50&after=${latest.messages.at(-1)!.id}`);
    expect(texts(newer)).toEqual(
      Array.from({ length: 5 }, (_, i) => [`q${20 + i}`, `a${20 + i}`]).flat(),
    );
    expect(newer.page!.newerCursor).toBeNull();
  });

  it('opens around a message and pages forward to the end', async () => {
    const id = await conversation(100);
    const full = (await (await get(id)).json()) as PageBody;
    const target = full.messages[40]!;
    const window = await page(id, `?limit=20&around=${target.id}`);
    expect(window.page!.targetFound).toBe(true);
    expect(window.messages).toHaveLength(20);
    const index = window.messages.findIndex((message) => message.id === target.id);
    expect(index).toBe(9);
    expect(texts(window)).toEqual(full.messages.slice(31, 51).map(textOf));
    expect(window.page!.olderCursor).toBe(window.messages[0]!.id);
    expect(window.page!.newerCursor).toBe(window.messages.at(-1)!.id);
    expect(window.replies).toEqual([]);

    const seen = [...window.messages];
    let cursor = window.page!.newerCursor;
    let last: PageBody | null = null;
    while (cursor) {
      last = await page(id, `?limit=60&after=${cursor}`);
      seen.push(...last.messages);
      cursor = last.page!.newerCursor;
    }
    expect(seen.map(textOf)).toEqual(full.messages.slice(31).map(textOf));
    expect(last!.page!.olderCursor).toBe(last!.messages[0]!.id);

    // Near the start: the window simply begins at the first message.
    const early = await page(id, `?limit=20&around=${full.messages[2]!.id}`);
    expect(texts(early)).toEqual(full.messages.slice(0, 20).map(textOf));
    expect(early.page!.olderCursor).toBeNull();
  });

  it('opens at the end for a message that is not on the conversation', async () => {
    const id = await conversation(60);
    const other = await conversation(2);
    const foreign = ((await (await get(other)).json()) as PageBody).messages[0]!.id;
    for (const target of [foreign, 'no-such-message']) {
      const body = await page(id, `?limit=10&around=${target}`);
      expect(body.page!.targetFound).toBe(false);
      expect(texts(body)).toEqual([
        'q55',
        'a55',
        'q56',
        'a56',
        'q57',
        'a57',
        'q58',
        'a58',
        'q59',
        'a59',
      ]);
      expect(body.page!.newerCursor).toBeNull();
    }
  });

  it('pages the active reply of each turn and the latest turn’s alternatives', async () => {
    const id = await conversation(30);
    const all = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, id))
      .orderBy(schema.message.position);
    // An early turn's replaced reply (from before retries were limited to the
    // latest turn) and two replies to the latest turn, the first replaced.
    const earlyPrompt = all[10]!;
    const latestPrompt = all.at(-2)!;
    const lastReply = all.at(-1)!;
    const base = Date.UTC(2026, 0, 2);
    await pool.db.insert(schema.message).values([
      {
        threadId: id,
        userId: owner,
        role: 'assistant',
        position: 21,
        parentMessageId: earlyPrompt.id,
        parts: [{ type: 'text', text: 'early-replaced' }],
        status: 'complete',
        supersededAt: new Date(base),
        createdAt: new Date(base),
      },
    ]);
    await pool.db
      .update(schema.message)
      .set({ supersededAt: new Date(base) })
      .where(eq(schema.message.id, lastReply.id));
    await pool.db.insert(schema.message).values({
      threadId: id,
      userId: owner,
      role: 'assistant',
      position: 61,
      parentMessageId: latestPrompt.id,
      parts: [{ type: 'text', text: 'a29-retried' }],
      status: 'complete',
      createdAt: new Date(base + 1),
    });

    const full = (await (await get(id)).json()) as PageBody;
    const latest = await page(id, '?limit=8');
    expect(texts(latest).at(-1)).toBe('a29-retried');
    expect(latest.replies.map(textOf)).toEqual(['a29', 'a29-retried']);
    expect(latest.replies).toEqual(full.replies);
    expect(latest.page!.total).toBe(60);

    const pages: Wire[] = [...latest.messages];
    let cursor = latest.page!.olderCursor;
    while (cursor) {
      const older = await page(id, `?limit=8&before=${cursor}`);
      pages.unshift(...older.messages);
      cursor = older.page!.olderCursor;
    }
    expect(pages.map(textOf)).toEqual(full.messages.map(textOf));
    expect(pages.map(textOf)).not.toContain('early-replaced');
    expect(pages.map(textOf)).not.toContain('a29');

    // A replaced reply is not on the conversation: opening at it opens at the end.
    const replaced = await page(id, `?limit=4&around=${lastReply.id}`);
    expect(replaced.page!.targetFound).toBe(false);
    expect(replaced.replies.map(textOf)).toEqual(['a29', 'a29-retried']);
  });

  it('pages a branch as its own conversation and refuses the source’s cursors', async () => {
    const source = await conversation(12);
    const full = (await (await get(source)).json()) as PageBody;
    const edited = full.messages[8]!;
    const response = await app.request(`/api/threads/${source}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner },
      body: JSON.stringify({ messageId: edited.id, text: 'q4-edited' }),
    });
    expect(response.status).toBe(201);
    const branch = ((await response.json()) as { thread: { id: string } }).thread.id;

    const latest = await page(branch, '?limit=4');
    expect(texts(latest)).toEqual(['a2', 'q3', 'a3', 'q4-edited']);
    const all: Wire[] = [...latest.messages];
    let cursor = latest.page!.olderCursor;
    while (cursor) {
      const older = await page(branch, `?limit=4&before=${cursor}`);
      all.unshift(...older.messages);
      cursor = older.page!.olderCursor;
    }
    expect(all.map(textOf)).toEqual(['q0', 'a0', 'q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4-edited']);
    expect(latest.page!.total).toBe(9);

    // A cursor from the source conversation names no message of the branch.
    const crossed = await get(branch, `?limit=4&before=${full.messages[4]!.id}`);
    expect(crossed.status).toBe(422);
    // And the source is unchanged.
    expect(texts(await page(source, '?limit=24'))).toEqual(full.messages.map(textOf));
  });

  it('titles every edit from its revised question, so branches can be told apart (#278)', async () => {
    const source = await conversation(3);
    const full = (await (await get(source)).json()) as PageBody;
    const edit = async (threadId: string, messageId: string, text: string) => {
      const response = await app.request(`/api/threads/${threadId}/branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': owner },
        body: JSON.stringify({ messageId, text }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { thread: { id: string; title: string } };
    };
    // A later question edited twice, and again inside the first branch.
    const first = await edit(source, full.messages[2]!.id, 'q1 as a table');
    const second = await edit(source, full.messages[2]!.id, 'q1 in French');
    const inBranch = (await page(first.thread.id, '?limit=10')).messages.at(-1)!;
    const third = await edit(first.thread.id, inBranch.id, 'q1 as a shorter table');
    expect([first, second, third].map((result) => result.thread.title)).toEqual([
      'q1 as a table',
      'q1 in French',
      'q1 as a shorter table',
    ]);
    // Editing the first question was already titled this way.
    expect((await edit(source, full.messages[0]!.id, 'q0 again')).thread.title).toBe('q0 again');
  });

  it('validates paging parameters and ownership', async () => {
    const id = await conversation(4);
    const first = ((await (await get(id)).json()) as PageBody).messages[0]!.id;
    expect((await get(id, '?limit=0')).status).toBe(422);
    expect((await get(id, '?limit=501')).status).toBe(422);
    expect((await get(id, `?before=${first}&after=${first}`)).status).toBe(422);
    expect((await get(id, '?before=not-a-message')).status).toBe(422);
    expect((await get(id, '?limit=10', stranger)).status).toBe(404);
    // Unknown parameters are ignored, as before v0.11.
    const body = (await (await get(id, '?unknown=1')).json()) as Record<string, unknown>;
    expect('page' in body).toBe(false);
    // Before the first message: an empty page with nothing older.
    const empty = await page(id, `?limit=5&before=${first}`);
    expect(empty.messages).toEqual([]);
    expect(empty.page).toEqual({ olderCursor: null, newerCursor: null, total: 8 });
    expect(empty.replies).toEqual([]);
  });
});
