import { runPostMigrations, sql } from '@oci/db';
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
 * Search ignores accents (#362), against real Postgres and the real post-deploy
 * step: before step 0012 has built the folded index search is exact about
 * accents (the old index), after it "bibliotheque" finds "bibliothèque" and
 * the folded index is the one the planner uses.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', folded: false }));

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
// Whether step 0012 has finished is the only thing replaced: it is read from
// the oci_post_migration table, which the real step fills in below.
vi.mock('../../services/migrations/readiness.js', () => ({
  isPostStepDone: async () => state.folded,
}));

import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { threadRoutes } from '../../routes/threads.js';
import {
  FOLDED_SEARCH_STEP,
  foldedMessageSearchVector,
  threadSearchStatement,
} from '../../services/thread-search.js';

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

  it('is exact about accents until the folded index is built, as before', async () => {
    expect(await found('bibliothèque')).toEqual(['Notes de lecture']);
    expect(await found('bibliotheque')).toEqual([]);
    expect(await found('busqueda')).toEqual([]);
    // Non-Latin search is unaffected.
    expect(await found('日本語')).toEqual(['日本語の宿題']);
  });

  it('finds accented words from unaccented ones once step 0012 has run', async () => {
    const outcome = await runPostMigrations(live.connectionString, {
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    expect(outcome.steps.find((step) => step.name === FOLDED_SEARCH_STEP)?.outcome).toBe('applied');
    state.folded = true;

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

  it('still finds other scripts, whose letters are not folded', async () => {
    expect(await found('اكتب')).toEqual(['واجب الكتابة']);
    expect(await found('المكتبة')).toEqual(['واجب الكتابة']);
    expect(await found('日本語')).toEqual(['日本語の宿題']);
    expect(await found('がっこう')).toEqual(['日本語の宿題']);
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

  it('ignores accents in the conversation list filter too', async () => {
    const response = await appFor(ownerId).request('/api/threads?search=busqueda');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: { id: string }[] };
    expect(body.threads.map((thread) => thread.id)).toEqual([ids.title]);
  });

  it('is answered by the folded index, on exactly the indexed expression', async () => {
    const plans = await live.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const predicate = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select m.id from message m
        where ${foldedMessageSearchVector('m')} @@ ${"'bibliotheque':*"}::tsquery
      `);
      const statement = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain ${threadSearchStatement(
          ownerId,
          { tsquery: "'bibliotheque':*", terms: ['bibliotheque'], folded: true },
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
