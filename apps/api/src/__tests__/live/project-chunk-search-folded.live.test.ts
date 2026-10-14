import { randomUUID } from 'node:crypto';
import {
  CHUNK_SEARCH_FOLDED,
  chunkSearchFolded as chunkBackfill,
  createDatabase,
  scheduleBackgroundMigrations,
} from '@oci/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Accent-insensitive keyword search of project files (#362,
 * SPEC-accent-search.md) against real PostgreSQL: the trigger that keeps
 * `project_file_chunk.search_folded`, the background migration
 * `0.13.chunk-search-folded` that fills it for older chunks, and retrieval,
 * which searches as v0.12 did until that is done and ignores accents after.
 */
const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));

const { runBackgroundMigrations } = await import('../../services/migrations/background-runner.js');
const { resetReadinessCache } = await import('../../services/migrations/readiness.js');
const { projectSearchTerms, rankProjectChunks } = await import(
  '../../services/project-search/retrieval.js'
);

const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: project file chunks ignore accents', () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  let userId: string;
  let projectId: string;
  let fileId: string;
  let ordinal = 0;

  async function addChunk(content: string): Promise<number> {
    const at = ordinal++;
    await client`
      insert into project_file_chunk (attachment_id, ordinal, start_offset, end_offset, content)
      values (${fileId}, ${at}, ${at * 100}, ${at * 100 + 90}, ${content})`;
    return at;
  }
  const vector = async (at: number) =>
    (
      await client<{ v: string | null }[]>`
        select search_folded::text as v from project_file_chunk
        where attachment_id = ${fileId} and ordinal = ${at}`
    )[0]!.v;

  async function search(query: string): Promise<string[]> {
    const terms = await projectSearchTerms(query);
    const rows = await rankProjectChunks({ userId, projectId, fileIds: [fileId] }, terms, 10);
    return rows.map((row) => row.content);
  }

  beforeAll(async () => {
    live = await createLiveDatabase('project_chunk_search_folded');
    const app = createDatabase(live.connectionString, { max: 4 });
    client = app.sql;
    state.db = app.db;
    state.sql = client;
    const organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, organizationId, { email: 'owner@example.com' });
    const [project] = await client<{ id: string }[]>`
      insert into project (organization_id, user_id, name)
      values (${organizationId}, ${userId}, 'Handbook') returning id`;
    projectId = project!.id;
    const [file] = await client<{ id: string }[]>`
      insert into attachment (organization_id, user_id, project_id, filename, mime_type, size_bytes, storage_key)
      values (${organizationId}, ${userId}, ${projectId}, 'notes.txt', 'text/plain', 100, ${randomUUID()})
      returning id`;
    fileId = file!.id;
  });
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  it('keeps the folded vector by trigger, NULL when nothing folds', async () => {
    const accented = await addChunk('Visitez la bibliothèque municipale, très belle.');
    const plain = await addChunk('Plain English about quokkas.');
    const german = await addChunk('Die Straße nach Köln und das Œuvre.');
    expect(await vector(accented)).toContain("'bibliotheque'");
    expect(await vector(plain)).toBeNull();
    expect(await vector(german)).toContain("'strasse'");
    expect(await vector(german)).toContain("'oeuvre'");

    // Follows the text when it changes, and does no work when it does not.
    await client`update project_file_chunk set content = 'Plain now'
      where attachment_id = ${fileId} and ordinal = ${accented}`;
    expect(await vector(accented)).toBeNull();
    await client`update project_file_chunk set content = 'Café au lait'
      where attachment_id = ${fileId} and ordinal = ${accented}`;
    expect(await vector(accented)).toContain("'cafe'");
    await client`update project_file_chunk set start_offset = 1
      where attachment_id = ${fileId} and ordinal = ${accented}`;
    expect(await vector(accented)).toContain("'cafe'");
    // Put it back for the search tests.
    await client`update project_file_chunk set content = 'Visitez la bibliothèque municipale, très belle.'
      where attachment_id = ${fileId} and ordinal = ${accented}`;
  });

  it('is exact about accents until the backfill is done, as v0.12 was', async () => {
    // As if every chunk had been written before migration 0049.
    await client`update project_file_chunk set search_folded = null`;
    resetReadinessCache();
    expect(await search('bibliothèque')).toEqual([
      'Visitez la bibliothèque municipale, très belle.',
    ]);
    expect(await search('bibliotheque')).toEqual([]);
    expect(await search('quokkas')).toEqual(['Plain English about quokkas.']);
    const terms = await projectSearchTerms('bibliotheque');
    expect(terms.every((term) => term.folded === false)).toBe(true);
  });

  it('is complete, resumable and repeatable once it runs', async () => {
    // Enough chunks to need several batches.
    for (let i = 0; i < 40; i++) await addChunk(`Épisode numéro ${i}, très long.`);
    await client`update project_file_chunk set search_folded = null`;
    expect(await scheduleBackgroundMigrations(client, [chunkBackfill])).toEqual([
      CHUNK_SEARCH_FOLDED,
    ]);
    await client`update background_migration set batch_size = 7, pause_ms = 0`;
    // A batch run twice (a lost commit) changes nothing.
    await client.begin((tx) => chunkBackfill.batch(tx, { cursor: null, batchSize: 7 }));
    await client.begin((tx) => chunkBackfill.batch(tx, { cursor: null, batchSize: 7 }));
    await runBackgroundMigrations({
      client,
      definitions: [chunkBackfill],
      throttle: async () => null,
      shouldStop: () => false,
    });
    const [migration] = await client<{ status: string }[]>`
      select status from background_migration where name = ${CHUNK_SEARCH_FOLDED}`;
    expect(migration?.status).toBe('finished');
    const [left] = await client<{ n: number }[]>`
      select count(*)::int as n from project_file_chunk
      where search_folded is null and oci_chunk_folded_vector(content) is not null`;
    expect(left!.n).toBe(0);
    const [plain] = await client<{ n: number }[]>`
      select count(*)::int as n from project_file_chunk
      where search_folded is not null and content = 'Plain English about quokkas.'`;
    expect(plain!.n).toBe(0);
  });

  it('then finds accented words from unaccented ones, and the reverse', async () => {
    resetReadinessCache();
    const terms = await projectSearchTerms('bibliotheque');
    expect(terms.every((term) => term.folded)).toBe(true);
    for (const query of ['bibliotheque', 'bibliothèque', 'BIBLIOTHEQUE', 'biblio']) {
      expect(await search(query), query).toEqual([
        'Visitez la bibliothèque municipale, très belle.',
      ]);
    }
    expect(await search('strasse')).toEqual(['Die Straße nach Köln und das Œuvre.']);
    expect(await search('oeuvre')).toEqual(['Die Straße nach Köln und das Œuvre.']);
    expect(await search('koln')).toEqual(['Die Straße nach Köln und das Œuvre.']);
    // What it found before, it still finds.
    expect(await search('quokkas')).toEqual(['Plain English about quokkas.']);
  });
});
