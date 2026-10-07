import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from '@oci/db';
import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START, type ThreadSearchResult } from '@oci/shared';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Search and accents (#362), against real Postgres and the real optional SQL
 * file. Titles ignore accents always. Message text is exact about accents (the
 * old index) until an operator builds the optional folded index by running
 * packages/db/optional/message_text_search_folded_index.sql; the application
 * notices the index by itself (no code change, no restart), and uses it only
 * while it exists and is valid, so the folded expression never runs without it.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));

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
import {
  FOLDED_SEARCH_INDEX,
  FOLDED_SEARCH_INDEX_FILE,
  foldedMessageSearchVector,
  foldedSearchReady,
  resetFoldedSearchReady,
  threadSearchStatement,
} from '../../services/thread-search.js';

const optionalSql = readFileSync(
  fileURLToPath(
    new URL(`../../../../../packages/db/optional/${FOLDED_SEARCH_INDEX_FILE}`, import.meta.url),
  ),
  'utf8',
);

const text = (value: string) => ({ type: 'text', text: value });

describe.skipIf(!available)('live Postgres: search ignores accents', () => {
  let live: LiveDatabase;
  let ownerId: string;
  const ids: Record<string, string> = {};

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

  async function results(query: string) {
    const response = await appFor(ownerId).request(
      `/api/threads/search?${new URLSearchParams({ q: query })}`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { results: ThreadSearchResult[] }).results;
  }

  const found = async (query: string) => (await results(query)).map((hit) => hit.thread.title);

  async function createThread(key: string, title: string, parts: unknown[] = []) {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${state.organizationId}, ${ownerId}, ${title})
      returning id
    `);
    if (!row) throw new Error('Failed to create thread');
    ids[key] = row.id;
    if (parts.length > 0) {
      await live.db.execute(sql`
        insert into message (thread_id, user_id, role, parts, position)
        values (${row.id}, ${ownerId}, 'assistant', ${JSON.stringify(parts)}::jsonb, 0)
      `);
    }
  }

  beforeAll(async () => {
    live = await createLiveDatabase('thread_search_accents');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    await createThread('library', 'Notes de lecture', [
      text('Visitez la bibliothèque municipale, elle est très belle.'),
    ]);
    await createThread('title', 'Walk9 Búsqueda de archivos');
    // JSON escapes (a quote, a line break) survive the fold and read back as JSON.
    await createThread('escapes', 'Escapes', [text('première ligne\nseconde "citation" été\tfin')]);
    await createThread('romanian', 'Ștefan cel Mare');
    await createThread('vietnam', 'Việt Nam', [text('Phở là món ăn nổi tiếng.')]);
    await createThread('arabic', 'واجب الكتابة', [text('اكتب لي جملتين عن المكتبة.')]);
    await createThread('japanese', '日本語の宿題', [text('がっこうのしゅくだい')]);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function indexState(): Promise<'missing' | 'valid' | 'invalid'> {
    const [row] = await live.db.execute<{ valid: boolean }>(sql`
      select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid
      where c.relname = ${FOLDED_SEARCH_INDEX}`);
    return row ? (row.valid ? 'valid' : 'invalid') : 'missing';
  }

  /** Runs the statement in `sql` as an operator's `psql -f` would: on its own connection, no transaction. */
  async function runByHand(statement: string) {
    const client = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    try {
      await client.unsafe(statement).simple();
    } finally {
      await client.end({ timeout: 1 });
      // The application re-reads the index state after a short time; do not wait for it.
      resetFoldedSearchReady();
    }
  }

  describe('without the optional index (what an upgrade ships)', () => {
    it('is not ready, and message text is exact about accents, as before', async () => {
      expect(await indexState()).toBe('missing');
      expect(await foldedSearchReady()).toBe(false);
      expect(await found('bibliothèque')).toEqual(['Notes de lecture']);
      expect(await found('bibliotheque')).toEqual([]);
      expect(await found('pho')).toEqual([]);
      expect(await found('phở')).toEqual(['Việt Nam']);
      // Non-Latin search is unaffected.
      expect(await found('日本語')).toEqual(['日本語の宿題']);
    });

    it('still ignores accents in titles', async () => {
      expect(await found('busqueda')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('BUSQUEDA')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('búsqueda')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('stefan')).toEqual(['Ștefan cel Mare']);
      expect(await found('viet nam')).toEqual(['Việt Nam']);
      const [title] = await results('busqueda');
      expect(title?.titleHighlight).toBe(
        `Walk9 ${SEARCH_HIGHLIGHT_START}Búsqueda${SEARCH_HIGHLIGHT_END} de archivos`,
      );
    });

    it('ignores accents in the conversation list filter', async () => {
      const response = await appFor(ownerId).request('/api/threads?search=busqueda');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { threads: { id: string }[] };
      expect(body.threads.map((thread) => thread.id)).toEqual([ids.title]);
    });

    it('never evaluates the folded message expression, which no index could answer', async () => {
      const statement = await live.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`explain ${threadSearchStatement(
            ownerId,
            {
              tsquery: "'bibliotheque':*",
              terms: ['bibliotheque'],
              folded: false,
              titleTsquery: "'bibliotheque':*",
              titleTerms: ['bibliotheque'],
            },
            'bibliotheque',
            20,
          )}`,
        );
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(statement).not.toContain(FOLDED_SEARCH_INDEX);
      expect(statement).not.toMatch(/translate\(\(?jsonb_path_query_array/);
    });

    it('does not use an INVALID index of that name (a build that failed or was cancelled)', async () => {
      // A unique build over duplicates fails and leaves an INVALID index behind.
      await expect(
        runByHand(`create unique index concurrently "${FOLDED_SEARCH_INDEX}" on message (role)`),
      ).rejects.toThrow();
      expect(await indexState()).toBe('invalid');
      expect(await foldedSearchReady()).toBe(false);
      expect(await found('bibliotheque')).toEqual([]);
      await runByHand(`drop index concurrently "${FOLDED_SEARCH_INDEX}"`);
      expect(await indexState()).toBe('missing');
    });
  });

  describe('with the optional index, built by running its SQL file', () => {
    beforeAll(async () => {
      // Exactly what an operator runs: the shipped file, outside any transaction.
      await runByHand(optionalSql);
    });

    it('is built, valid and noticed without a code change', async () => {
      expect(await indexState()).toBe('valid');
      expect(await foldedSearchReady()).toBe(true);
    });

    it('finds accented words from unaccented ones', async () => {
      for (const query of [
        'bibliotheque',
        'bibliothèque',
        'BIBLIOTHEQUE',
        'Bibliothéque',
        'biblio',
      ]) {
        expect(await found(query)).toEqual(['Notes de lecture']);
      }
      expect(await found('busqueda')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('búsqueda')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('stefan')).toEqual(['Ștefan cel Mare']);
      expect(await found('viet nam')).toEqual(['Việt Nam']);
      expect(await found('pho')).toEqual(['Việt Nam']);
      expect(await found('premiere ete')).toEqual(['Escapes']);
      expect(await found('seconde citation')).toEqual(['Escapes']);
    });

    it('is exact about accents again once the index is dropped, after the answer expires', async () => {
      await runByHand(`drop index concurrently "${FOLDED_SEARCH_INDEX}"`);
      expect(await foldedSearchReady()).toBe(false);
      expect(await found('bibliotheque')).toEqual([]);
      await runByHand(optionalSql);
      expect(await found('bibliotheque')).toEqual(['Notes de lecture']);
    });
  });

  it('with the index, still finds other scripts, whose letters are not folded', async () => {
    expect(await found('اكتب')).toEqual(['واجب الكتابة']);
    expect(await found('المكتبة')).toEqual(['واجب الكتابة']);
    expect(await found('日本語')).toEqual(['日本語の宿題']);
    expect(await found('がっこう')).toEqual(['日本語の宿題']);
  });

  it('with the index, highlights the word as written, accents kept', async () => {
    const [hit] = await results('bibliotheque');
    expect(hit?.matches[0]?.snippet).toContain(
      `${SEARCH_HIGHLIGHT_START}bibliothèque${SEARCH_HIGHLIGHT_END}`,
    );
    const [title] = await results('busqueda');
    expect(title?.titleHighlight).toBe(
      `Walk9 ${SEARCH_HIGHLIGHT_START}Búsqueda${SEARCH_HIGHLIGHT_END} de archivos`,
    );
  });

  it('with the index, is answered by it, on exactly the indexed expression', async () => {
    const plans = await live.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const predicate = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select m.id from message m
        where ${foldedMessageSearchVector('m')} @@ ${"'bibliotheque':*"}::tsquery
      `);
      const statement = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${threadSearchStatement(
          ownerId,
          {
            tsquery: "'bibliotheque':*",
            terms: ['bibliotheque'],
            folded: true,
            titleTsquery: "'bibliotheque':*",
            titleTerms: ['bibliotheque'],
          },
          'bibliotheque',
          20,
        )}`,
      );
      return {
        predicate: predicate.map((row) => row['QUERY PLAN']).join('\n'),
        statement: statement.map((row) => row['QUERY PLAN']).join('\n'),
      };
    });
    expect(plans.predicate).toContain('message_text_search_folded_idx');
    const indexed = plans.predicate.match(/Index Cond: \((.*) @@ /)?.[1];
    expect(indexed).toContain('translate(');
    expect(plans.statement).toContain(`${indexed} @@`);
  });
});
