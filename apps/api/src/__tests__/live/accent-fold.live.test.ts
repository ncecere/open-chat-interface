import { sql } from '@oci/db';
import type { ThreadSearchResult } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { FOLD_EXPANSIONS, FOLD_FROM, foldAccents } from '../../lib/fold.js';

/**
 * One fold for search (#362, SPEC-accent-search.md): the SQL function
 * `oci_fold_search_text` and `foldAccents` agree on every mapped letter, and
 * titles (which are folded in the query, with no index) find "Straße" by
 * `strasse` and "Œuvres" by `oeuvres`, which one-to-one folding could not.
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

const SAMPLES = [
  'Bibliothèque municipale, très belle',
  'Búsqueda de archivos, ¿qué tal? Año nuevo',
  'Straße, groß, STRAẞE, Fußball',
  'Œuvres complètes, cœur, sœur, Æsop, Ærø, æther',
  'Coração, informação, São Paulo, Ação',
  'Việt Nam, Phở, nước, đường, Hà Nội',
  'Łódź, Żółć, gęś, Dziękuję, Kraków',
  'İstanbul, Türkçe, ışık, şeker, ğ, Çanakkale',
  '日本語の宿題 Привет مرحبا 한국어 नमस्ते',
  'l\'été "citation"\n\ttab',
];

describe.skipIf(!available)('live Postgres: the search fold', () => {
  let live: LiveDatabase;
  let ownerId: string;

  const fold = async (value: string) => {
    const [row] = await live.db.execute<{ folded: string }>(
      sql`select oci_fold_search_text(${value}::text) as folded`,
    );
    return row!.folded;
  };

  async function found(query: string) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: ownerId,
        email: 'owner@example.com',
        name: 'Owner',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    const response = await app.request(`/api/threads/search?${new URLSearchParams({ q: query })}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: ThreadSearchResult[] };
    return body.results.map((hit) => hit.thread.title);
  }

  beforeAll(async () => {
    live = await createLiveDatabase('accent_fold');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    for (const title of ['Straße nach Köln', 'Œuvres complètes', 'Ærø rejser', 'Plain title'])
      await live.db.execute(sql`
        insert into thread (organization_id, user_id, title)
        values (${state.organizationId}, ${ownerId}, ${title})
      `);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('agrees with the TypeScript fold on every one-to-one letter', async () => {
    const letters = [...FOLD_FROM];
    const rows = await live.db.execute<{ letter: string; folded: string }>(sql`
      select letter, oci_fold_search_text(letter) as folded
      from unnest(${sql.raw(`ARRAY[${letters.map((l) => `'${l}'`).join(',')}]::text[]`)}) as t(letter)
    `);
    expect(rows).toHaveLength(letters.length);
    for (const { letter, folded } of rows) expect(folded, letter).toBe(foldAccents(letter));
  });

  it('agrees on the letters that become two, in both cases', async () => {
    for (const [letter, expansion] of FOLD_EXPANSIONS) {
      expect(await fold(letter)).toBe(expansion);
      expect(await fold(`x${letter}y`)).toBe(`x${expansion}y`);
    }
  });

  it('agrees on sample text in French, Spanish, German, Portuguese, Vietnamese, Polish, Turkish and other scripts', async () => {
    for (const sample of SAMPLES) expect(await fold(sample), sample).toBe(foldAccents(sample));
  });

  it('is immutable, so a stored vector made with it never changes under the same text', async () => {
    const [row] = await live.db.execute<{ volatility: string; strict: boolean }>(sql`
      select provolatile as volatility, proisstrict as strict
      from pg_proc where proname = 'oci_fold_search_text'
    `);
    expect(row).toEqual({ volatility: 'i', strict: true });
  });

  it('finds titles by their folded form, including ß, æ and œ', async () => {
    expect(await found('strasse')).toEqual(['Straße nach Köln']);
    expect(await found('Straße')).toEqual(['Straße nach Köln']);
    expect(await found('oeuvres')).toEqual(['Œuvres complètes']);
    expect(await found('aero')).toEqual(['Ærø rejser']);
    expect(await found('koln')).toEqual(['Straße nach Köln']);
  });
});
