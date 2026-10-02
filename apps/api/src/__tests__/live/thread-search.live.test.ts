import { sql } from '@oci/db';
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START, type ThreadSearchResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Conversation search through the real route and migrations.
 *
 * Search returns other people's words if ownership is wrong, and runs on an
 * expression index that silently stops being used if the query's expression
 * drifts from the migration's. Both are only provable against Postgres.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({ branching: true, shareLinks: true, temporaryChat: true }),
}));

import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { threadRoutes } from '../../routes/threads.js';
import { messageSearchVector, threadSearchStatement } from '../../services/thread-search.js';

type Part = Record<string, unknown>;

describe.skipIf(!available)('live Postgres: conversation search', () => {
  let live: LiveDatabase;
  let ownerId: string;
  let strangerId: string;
  const ids: Record<string, string> = {};
  const messageIds: Record<string, string> = {};

  function appFor(userId: string) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        email: 'user@example.com',
        name: 'User',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    return app;
  }

  async function search(query: string, options: { userId?: string; limit?: string } = {}) {
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set('limit', options.limit);
    const response = await appFor(options.userId ?? ownerId).request(
      `/api/threads/search?${params}`,
    );
    return response;
  }

  async function results(query: string, options: { userId?: string; limit?: string } = {}) {
    const response = await search(query, options);
    expect(response.status).toBe(200);
    return ((await response.json()) as { results: ThreadSearchResult[] }).results;
  }

  async function createThread(
    key: string,
    title: string,
    options: {
      userId?: string;
      archived?: boolean;
      temporary?: boolean;
      deleted?: boolean;
      lastMessageAt?: string;
    } = {},
  ) {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title, archived, temporary, expires_at, deleted_at, deleted_reason, last_message_at)
      values (
        ${state.organizationId}, ${options.userId ?? ownerId}, ${title},
        ${options.archived ?? false}, ${options.temporary ?? false},
        ${options.temporary ? sql`now() + interval '1 day'` : null},
        ${options.deleted ? sql`now()` : null}, ${options.deleted ? 'user' : null},
        ${options.lastMessageAt ?? null}
      )
      returning id
    `);
    if (!row) throw new Error('Failed to create thread');
    ids[key] = row.id;
    return row.id;
  }

  async function addMessage(key: string, threadKey: string, role: string, parts: Part[]) {
    const threadId = ids[threadKey];
    const [owner] = await live.db.execute<{ user_id: string }>(
      sql`select user_id from thread where id = ${threadId}`,
    );
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (
        ${threadId}, ${owner?.user_id}, ${role}, ${JSON.stringify(parts)}::jsonb,
        (select coalesce(max(position), -1) + 1 from message where thread_id = ${threadId})
      )
      returning id
    `);
    if (!row) throw new Error('Failed to create message');
    messageIds[key] = row.id;
  }

  const text = (value: string): Part => ({ type: 'text', text: value });

  beforeAll(async () => {
    live = await createLiveDatabase('thread_search');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    strangerId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });

    await createThread('planning', 'Migration planning');
    await addMessage('planningQuestion', 'planning', 'user', [
      text('How should we move the database?'),
      {
        type: 'data-attachment',
        data: { id: 'a1', filename: 'quokkafile.pdf', mimeType: 'application/pdf', url: '/x' },
      },
    ]);
    await addMessage('planningAnswer', 'planning', 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'secretthought about the wombat schema', state: 'done' },
      text('Start with the schema, then backfill.\n\nVerify afterwards.'),
      { type: 'source-url', sourceId: 's1', url: 'https://example.com', title: 'Sourcetitleword' },
    ]);

    await createThread('island', 'Holiday ideas', { lastMessageAt: '2026-01-01T00:00:00Z' });
    await addMessage('islandQuestion', 'island', 'user', [
      text('Kangaroo island trip: kangaroo spotting, kangaroo photos.'),
    ]);

    await createThread('passing', 'Random notes', { lastMessageAt: '2026-02-01T00:00:00Z' });
    await addMessage('passingQuestion', 'passing', 'user', [
      text(
        `${'Plenty of other words about gardening, weather, cooking and travel. '.repeat(8)}A kangaroo appears once here.`,
      ),
    ]);

    await createThread('archived', 'Old notes', { archived: true });
    await addMessage('archivedAnswer', 'archived', 'assistant', [
      text('An archived kangaroo fact.'),
    ]);

    await createThread('trashed', 'Deleted notes', { deleted: true });
    await addMessage('trashedAnswer', 'trashed', 'assistant', [text('A trashed kangaroo fact.')]);

    await createThread('temporary', 'Temporary notes', { temporary: true });
    await addMessage('temporaryAnswer', 'temporary', 'assistant', [text('A temporary kangaroo.')]);

    await createThread('stranger', 'Stranger kangaroo thread', { userId: strangerId });
    await addMessage('strangerAnswer', 'stranger', 'assistant', [text('Stranger kangaroo.')]);

    await createThread('markup', 'Markup sample');
    await addMessage('markupAnswer', 'markup', 'assistant', [
      text(
        `Example <script>alert('x')</script> and <b>bold</b> wallaby ${SEARCH_HIGHLIGHT_START}forged${SEARCH_HIGHLIGHT_END} marker.`,
      ),
    ]);

    for (let index = 0; index < 55; index += 1) {
      await createThread(`bulk${index}`, `Bulk ${index}`);
      await addMessage(`bulkMessage${index}`, `bulk${index}`, 'user', [
        text(`lemur number ${index}`),
      ]);
    }
  });

  afterAll(async () => {
    await live?.destroy();
  });

  it('matches message text and points at the message', async () => {
    const found = await results('backfill');
    expect(found).toHaveLength(1);
    const [result] = found;
    expect(result?.thread.id).toBe(ids.planning);
    expect(result?.matches).toEqual([
      {
        messageId: messageIds.planningAnswer,
        role: 'assistant',
        snippet: expect.stringContaining(
          `${SEARCH_HIGHLIGHT_START}backfill${SEARCH_HIGHLIGHT_END}`,
        ),
      },
    ]);
    // Snippets are one line even when the message has paragraphs.
    expect(result?.matches[0]?.snippet).not.toMatch(/\n/);
  });

  it('matches titles, including a title-only match with no message snippets', async () => {
    const found = await results('planning');
    expect(found.map((result) => result.thread.id)).toEqual([ids.planning]);
    expect(found[0]?.matches).toEqual([]);
    expect(found[0]?.titleHighlight).toBe(
      `Migration ${SEARCH_HIGHLIGHT_START}planning${SEARCH_HIGHLIGHT_END}`,
    );
    expect(found[0]?.thread.title).toBe('Migration planning');
  });

  it('keeps title substring matching from the old title search', async () => {
    const found = await results('gration');
    expect(found.map((result) => result.thread.id)).toEqual([ids.planning]);
  });

  it('matches word prefixes', async () => {
    const found = await results('kanga');
    expect(found.map((result) => result.thread.id).sort()).toEqual(
      [ids.island, ids.passing, ids.archived].sort(),
    );
  });

  it('requires every word (AND) in any order', async () => {
    expect((await results('island kangaroo')).map((result) => result.thread.id)).toEqual([
      ids.island,
    ]);
    expect(await results('kangaroo nonexistentword')).toEqual([]);
  });

  it('ranks denser matches first, then by recency', async () => {
    const found = await results('kangaroo');
    const order = found.map((result) => result.thread.id);
    expect(order.indexOf(ids.island ?? '')).toBeLessThan(order.indexOf(ids.passing ?? ''));
    for (let index = 1; index < found.length; index += 1) {
      expect(found[index - 1]?.rank).toBeGreaterThanOrEqual(found[index]?.rank ?? 0);
    }
  });

  it('breaks rank ties by most recent activity', async () => {
    await createThread('olderTie', 'Tie one', { lastMessageAt: '2025-01-01T00:00:00Z' });
    await addMessage('olderTieMessage', 'olderTie', 'user', [text('platypus burrow')]);
    await createThread('newerTie', 'Tie two', { lastMessageAt: '2026-06-01T00:00:00Z' });
    await addMessage('newerTieMessage', 'newerTie', 'user', [text('platypus burrow')]);
    const found = await results('platypus');
    expect(found.map((result) => result.thread.id)).toEqual([ids.newerTie, ids.olderTie]);
    expect(found[0]?.rank).toBe(found[1]?.rank);
  });

  it('ranks a title match above a passing mention in text', async () => {
    await createThread('titled', 'Kangaroo care guide');
    const found = await results('kangaroo');
    expect(found[0]?.thread.id).toBe(ids.titled);
  });

  it('only searches the signed-in person’s conversations', async () => {
    const mine = await results('stranger');
    expect(mine).toEqual([]);
    const theirs = await results('kangaroo', { userId: strangerId });
    expect(theirs.map((result) => result.thread.id)).toEqual([ids.stranger]);
  });

  it('excludes trashed and temporary conversations', async () => {
    const found = (await results('kangaroo')).map((result) => result.thread.id);
    expect(found).not.toContain(ids.trashed);
    expect(found).not.toContain(ids.temporary);
    expect(await results('trashed')).toEqual([]);
    expect(await results('temporary')).toEqual([]);
  });

  it('includes archived conversations and flags them', async () => {
    const found = await results('archived kangaroo');
    expect(found).toHaveLength(1);
    expect(found[0]?.thread.id).toBe(ids.archived);
    expect(found[0]?.thread.archived).toBe(true);
  });

  it('does not match reasoning, sources or attachment names', async () => {
    expect(await results('secretthought')).toEqual([]);
    expect(await results('wombat')).toEqual([]);
    expect(await results('sourcetitleword')).toEqual([]);
    expect(await results('quokkafile')).toEqual([]);
  });

  it('marks matches with control characters and never returns HTML markup', async () => {
    const found = await results('wallaby');
    expect(found).toHaveLength(1);
    const snippet = found[0]?.matches[0]?.snippet ?? '';
    expect(snippet).toContain(`${SEARCH_HIGHLIGHT_START}wallaby${SEARCH_HIGHLIGHT_END}`);
    expect(snippet).not.toMatch(/<\/?b>/);
    expect(snippet).not.toContain('<script>');
    // Markers stored in the message are removed, so only real matches carry them.
    expect(snippet.split(SEARCH_HIGHLIGHT_START)).toHaveLength(2);
    expect(snippet.split(SEARCH_HIGHLIGHT_END)).toHaveLength(2);
    expect(snippet).toContain('forged');
  });

  it('treats operators, quotes and punctuation as plain text', async () => {
    const hostile = [
      "'",
      '"',
      '&',
      '|',
      '!',
      ':',
      '*',
      '\\',
      '()',
      '<->',
      "kangaroo' | 'x",
      '!kangaroo',
      'kangaroo:*',
      'kangaroo & | ! : * ( ) <-> \\',
      '\u0000kangaroo',
      "kangaroo'; drop table message; --",
      '%',
      '_',
    ];
    for (const query of hostile) {
      const response = await search(query);
      expect(response.status, query).toBe(200);
      const body = (await response.json()) as { results: ThreadSearchResult[] };
      expect(Array.isArray(body.results), query).toBe(true);
    }
    expect((await results('!kangaroo')).length).toBeGreaterThan(0);
    expect((await results('kangaroo:*')).length).toBeGreaterThan(0);
    // Wildcards in the substring fallback are literal.
    expect(await results('%')).toEqual([]);
    expect(await results('_')).toEqual([]);
    const [{ count } = { count: 0 }] = await live.db.execute<{ count: number }>(
      sql`select count(*)::int as count from message`,
    );
    expect(count).toBeGreaterThan(0);
  });

  it('cuts very long input and refuses absurd input', async () => {
    const long = await search(`kangaroo ${'island '.repeat(250)}`);
    expect(long.status).toBe(200);
    expect(((await long.json()) as { results: unknown[] }).results.length).toBeGreaterThan(0);
    expect((await search('x'.repeat(2001))).status).toBe(422);
  });

  it('returns nothing for an empty or punctuation-only query', async () => {
    expect(await results('')).toEqual([]);
    expect(await results('   ')).toEqual([]);
    expect(await results('?!.,')).toEqual([]);
    expect((await appFor(ownerId).request('/api/threads/search')).status).toBe(422);
  });

  it('defaults to 20 results, honours a limit and clamps it at 50', async () => {
    expect(await results('lemur')).toHaveLength(20);
    expect(await results('lemur', { limit: '5' })).toHaveLength(5);
    expect(await results('lemur', { limit: '500' })).toHaveLength(50);
    expect((await search('lemur', { limit: '0' })).status).toBe(422);
    expect((await search('lemur', { limit: 'many' })).status).toBe(422);
  });

  it('returns at most three matches per conversation, best first', async () => {
    await createThread('many', 'Many echidna mentions');
    for (let index = 0; index < 5; index += 1) {
      await addMessage(`many${index}`, 'many', 'user', [
        text(`echidna ${'echidna '.repeat(index)}note ${index}`),
      ]);
    }
    const [result] = await results('echidna note');
    expect(result?.matches).toHaveLength(3);
    expect(result?.matches[0]?.messageId).toBe(messageIds.many4);
  });

  it('keeps the existing title search endpoint working', async () => {
    const response = await appFor(ownerId).request('/api/threads?search=Migration');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: { id: string }[] };
    expect(body.threads.map((thread) => thread.id)).toEqual([ids.planning]);
  });

  it('indexes exactly the expression the search uses', async () => {
    const [index] = await live.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where indexname = 'message_text_search_idx'
    `);
    expect(index?.indexdef).toContain('USING gin');
    expect(index?.indexdef).toContain('jsonb_path_query_array(parts');

    const plans = await live.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const predicate = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select m.id from message m
        where ${messageSearchVector('m')} @@ ${"'kangaroo':*"}::tsquery
      `);
      const statement = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${threadSearchStatement(ownerId, "'kangaroo':*", 'kangaroo', 20)}`,
      );
      return {
        predicate: predicate.map((row) => row['QUERY PLAN']).join('\n'),
        statement: statement.map((row) => row['QUERY PLAN']).join('\n'),
      };
    });
    // The text predicate alone can be answered from the GIN index.
    expect(plans.predicate).toContain('message_text_search_idx');
    // For a single person's conversations the planner may prefer walking their
    // threads; either way, the statement must evaluate the indexed expression
    // verbatim, so the index stays usable when the planner wants it.
    const indexed = plans.predicate.match(/Index Cond: \((.*) @@ /)?.[1];
    expect(indexed).toContain('to_tsvector');
    expect(plans.statement).toContain(`${indexed} @@`);
  });
});
