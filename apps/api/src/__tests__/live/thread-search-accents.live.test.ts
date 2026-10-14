import { createDatabase, messageSearchFolded, runPostMigrations, sql } from '@oci/db';
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
 * Search and accents (#362, SPEC-accent-search.md), against real Postgres.
 *
 * Titles ignore accents always. Message text is exact about accents (as v0.12
 * was) until BOTH the post-deploy step that builds the index over
 * `message.search_folded` and the background migration that fills it for older
 * messages are done; from then on a search matches the exact index or the
 * folded one, so it finds everything it found before and more.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({ branching: true, shareLinks: true, temporaryChat: true }),
}));

import type postgres from 'postgres';
import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { threadRoutes } from '../../routes/threads.js';
import { resetReadinessCache } from '../../services/migrations/readiness.js';
import {
  foldedSearchReady,
  messageSearchCondition,
  threadSearchStatement,
} from '../../services/thread-search.js';

const { runBackgroundMigrations } = await import('../../services/migrations/background-runner.js');

const text = (value: string) => ({ type: 'text', text: value });
const quiet = { info: () => {}, warn: () => {} };

const QUERIES = [
  'bibliotheque',
  'bibliothèque',
  'BIBLIOTHEQUE',
  'biblio',
  'busqueda',
  'búsqueda',
  'stefan',
  'viet nam',
  'pho',
  'phở',
  'premiere ete',
  'seconde citation',
  'strasse',
  'oeuvre',
  'plain',
  '日本語',
  'がっこう',
  'اكتب',
];

describe.skipIf(!available)('live Postgres: search ignores accents', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  let ownerId: string;
  const ids: Record<string, string> = {};
  const before = new Map<string, string[]>();

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
    client = createDatabase(live.connectionString, { max: 4 }).sql;
    state.db = live.db;
    state.sql = client;
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
    await createThread('german', 'Reise', [text('Die Straße nach Köln, das Œuvre.')]);
    await createThread('plain', 'Plain notes', [text('Just plain English words.')]);
    // As if every message was written before migration 0048 (the trigger had not run).
    await client`update message set search_folded = null`;
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  describe('right after the upgrade, before the stored vectors are ready', () => {
    it('is not ready, and message text is exact about accents, as v0.12 was', async () => {
      resetReadinessCache();
      expect(await foldedSearchReady()).toBe(false);
      expect(await found('bibliothèque')).toEqual(['Notes de lecture']);
      expect(await found('bibliotheque')).toEqual([]);
      expect(await found('pho')).toEqual([]);
      expect(await found('phở')).toEqual(['Việt Nam']);
      // Non-Latin search is unaffected.
      expect(await found('日本語')).toEqual(['日本語の宿題']);
      for (const query of QUERIES) before.set(query, await found(query));
    });

    it('still ignores accents in titles, and folds ß, æ and œ in them', async () => {
      expect(await found('busqueda')).toEqual(['Walk9 Búsqueda de archivos']);
      expect(await found('BUSQUEDA')).toEqual(['Walk9 Búsqueda de archivos']);
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

    it('never reads the stored column while it is not ready', async () => {
      const statement = await explain(false);
      expect(statement).not.toContain('search_folded');
    });

    it('is still not ready when the index is built but older messages are not filled', async () => {
      // The post-deploy step alone (no background migration scheduled yet).
      await runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] });
      resetReadinessCache();
      expect(await foldedSearchReady()).toBe(false);
      expect(await found('bibliotheque')).toEqual([]);
    });
  });

  describe('once the index is built and the older messages are filled', () => {
    beforeAll(async () => {
      await runPostMigrations(live.connectionString, {
        logger: quiet,
        backgroundMigrations: [messageSearchFolded],
      });
      // Not ready until it has actually run.
      resetReadinessCache();
      expect(await foldedSearchReady()).toBe(false);
      await client`update background_migration set batch_size = 3, pause_ms = 0`;
      await runBackgroundMigrations({
        client,
        definitions: [messageSearchFolded],
        throttle: async () => null,
        shouldStop: () => false,
      });
      resetReadinessCache();
    });

    it('is ready', async () => {
      expect(await foldedSearchReady()).toBe(true);
    });

    it('finds accented words from unaccented ones, and the reverse', async () => {
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
      expect(await found('stefan')).toEqual(['Ștefan cel Mare']);
      expect(await found('viet nam')).toEqual(['Việt Nam']);
      expect(await found('pho')).toEqual(['Việt Nam']);
      expect(await found('premiere ete')).toEqual(['Escapes']);
      expect(await found('seconde citation')).toEqual(['Escapes']);
    });

    it('finds ß, æ and œ by their folded spelling, and plain text as before', async () => {
      expect(await found('strasse')).toEqual(['Reise']);
      expect(await found('oeuvre')).toEqual(['Reise']);
      expect(await found('straße')).toEqual(['Reise']);
      expect(await found('koln')).toEqual(['Reise']);
      expect(await found('plain')).toEqual(['Plain notes']);
    });

    it('finds everything it found before, in the same order for those', async () => {
      for (const query of QUERIES) {
        const now = await found(query);
        const old = before.get(query) ?? [];
        for (const title of old) expect(now, query).toContain(title);
        expect(
          now.filter((title) => old.includes(title)),
          query,
        ).toEqual(old);
      }
    });

    it('still finds other scripts, whose letters are not folded', async () => {
      expect(await found('اكتب')).toEqual(['واجب الكتابة']);
      expect(await found('المكتبة')).toEqual(['واجب الكتابة']);
      expect(await found('日本語')).toEqual(['日本語の宿題']);
      expect(await found('がっこう')).toEqual(['日本語の宿題']);
    });

    it('finds a message written after the upgrade, through the trigger', async () => {
      await createThread('later', 'Later', [text('Une réunion à Montréal demain.')]);
      expect(await found('reunion montreal')).toEqual(['Later']);
      expect(await found('réunion')).toEqual(['Later']);
      // Edited: the vector follows the new text.
      await live.db.execute(sql`
        update message set parts = ${JSON.stringify([text('Plus de réunion.')])}::jsonb
        where thread_id = ${ids.later}
      `);
      expect(await found('montreal')).toEqual([]);
      expect(await found('reunion')).toEqual(['Later']);
    });

    it('highlights the word as written, accents kept', async () => {
      const [hit] = await results('bibliotheque');
      expect(hit?.matches[0]?.snippet).toContain(
        `${SEARCH_HIGHLIGHT_START}bibliothèque${SEARCH_HIGHLIGHT_END}`,
      );
      const [title] = await results('busqueda');
      expect(title?.titleHighlight).toBe(
        `Walk9 ${SEARCH_HIGHLIGHT_START}Búsqueda${SEARCH_HIGHLIGHT_END} de archivos`,
      );
    });

    it('is answered by both indexes, never by a scan that folds every message', async () => {
      const plan = await live.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`
          explain select m.id from message m
          where ${messageSearchCondition('m', sql`${"'bibliotheque':*"}::tsquery`, true)}
        `);
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('BitmapOr');
      expect(plan).toContain('message_search_folded_idx');
      expect(plan).toContain('message_text_search_idx');
      expect(plan).not.toMatch(/oci_fold_search_text\(\(?jsonb_path_query_array/);
    });
  });

  async function explain(folded: boolean): Promise<string> {
    return live.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${threadSearchStatement(
          ownerId,
          {
            tsquery: "'bibliotheque':*",
            terms: ['bibliotheque'],
            folded,
            titleTsquery: "'bibliotheque':*",
            titleTerms: ['bibliotheque'],
          },
          'bibliotheque',
          20,
        )}`,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  }
});
