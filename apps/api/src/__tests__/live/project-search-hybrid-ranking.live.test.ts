import { type createDatabase, eq, schema, sql } from '@oci/db';
import { PROJECT_EXCERPT_MAX_CHARS } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeEmbeddingModel, fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import { type LiveDatabase, livePostgresAvailable, seedUser } from '../../../test/live-postgres.js';
import {
  createHybridDatabases,
  destroyHybridDatabases,
  hybridHelpers,
  ledger,
  paragraph,
  QUESTION,
  TARGET,
} from '../../../test/project-search-hybrid.fixtures.js';

/**
 * Meaning-based search for project files (v0.9) against real PostgreSQL with
 * pgvector: keyword-only behaviour while the extension is absent, the runtime
 * embedding table, the background job, hybrid ranking with a deterministic
 * fake embeddings model, fallbacks, usage attribution and isolation.
 * This suite covers hybrid ranking with pgvector: paraphrases, unrelated passages,
 * fallbacks, rebuilds in a new generation and isolation; the shared fixtures live in
 * test/project-search-hybrid.fixtures.ts.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  fake: null as unknown,
}));
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
vi.mock('../../services/embeddings/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/embeddings/model.js')>();
  return {
    ...actual,
    resolveEmbeddingModel: async (providerId: string, modelId: string) =>
      state.fake ?? actual.resolveEmbeddingModel(providerId, modelId),
  };
});

const available = await livePostgresAvailable();
const { logger } = await import('../../lib/logger.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { indexUploadedProjectFile } = await import('../../services/project-search/indexing.js');
const { embedPendingProjectPassages, fillGeneration } = await import(
  '../../services/project-search/embedding.js'
);
const { semanticProjectChunks, vectorRankProjectChunks } = await import(
  '../../services/project-search/semantic.js'
);
const { resolveGenerations } = await import('../../services/embeddings/generations.js');
const { embeddingsStatus, embeddingsHealthCheck } = await import(
  '../../services/embeddings/status.js'
);

describe.skipIf(!available)('live: meaning-based project search', () => {
  let plain: LiveDatabase;
  let vector: LiveDatabase;
  let plainPool: ReturnType<typeof createDatabase>;
  let vectorPool: ReturnType<typeof createDatabase>;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let fake: FakeEmbeddingModel;

  async function useDatabase(target: 'plain' | 'vector') {
    pool = target === 'plain' ? plainPool : vectorPool;
    state.db = pool.db;
    invalidateSettingsCache();
  }

  const {
    chunkContents,
    configure,
    current,
    embedAll,
    embeddingRows,
    largeProject,
    passageText,
    project,
    projectFile,
    resetGenerations,
    select,
  } = hybridHelpers(state, () => ({ pool, owner }));

  beforeAll(async () => {
    ({ plain, vector, plainPool, vectorPool, owner } = await createHybridDatabases(state));
  });
  beforeEach(() => {
    fake = fakeEmbeddingModel();
    state.fake = fake;
    vi.mocked(logger.warn).mockClear();
  });
  afterAll(async () => {
    await destroyHybridDatabases({ plain, vector }, { plainPool, vectorPool });
  });

  describe('with pgvector', () => {
    beforeAll(() => useDatabase('vector'));
    beforeEach(async () => {
      // Each test starts from a clean, configured instance.
      await pool.db.execute(sql`delete from project`);
      await pool.db.execute(sql`delete from usage_event`);
      await pool.db.execute(sql`delete from usage_record`);
      await resetGenerations();
      await configure({});
    });

    it('finds a paraphrased passage that keyword search misses', async () => {
      const { project: target } = await largeProject('Hybrid');
      await embedAll();

      const hybrid = await select(target, QUESTION);
      expect(passageText(hybrid)).toContain(TARGET);
      expect(hybrid.search?.header).toContain('best match the latest message');
      expect(hybrid.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'hybrid' });
      expect(hybrid.searchPart?.data.files[0]?.name).toBe('facilities.txt');
      // The note keeps only the start of each passage used (v0.10), not the passage.
      for (const excerpt of hybrid.searchPart?.data.files[0]?.excerpts ?? [])
        expect(excerpt.snippet.length).toBeLessThanOrEqual(PROJECT_EXCERPT_MAX_CHARS + 1);
      expect(hybrid.searchPart?.data.files[0]?.excerpts).toHaveLength(1);

      // Exact words still count: the keyword match is merged in.
      const exact = await select(target, 'conservatory boiler ignition');
      expect(exact.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'hybrid' });
      expect(passageText(exact)).toContain(TARGET);

      // Switched off, the same question falls back to keyword search alone,
      // which finds nothing.
      await configure({ enabled: false });
      const keyword = await select(target, QUESTION);
      expect(keyword.searchPart).toBeNull();
      expect(passageText(keyword)).not.toContain(TARGET);
      // A message with nothing to search for is never embedded.
      await configure({});
      fake.embedded.length = 0;
      await select(target, '?! … —');
      expect(fake.embedded).toEqual([]);
    });

    it('leaves out passages unrelated in meaning, however near they are', async () => {
      const { project: target, notes, stock } = await largeProject('Unrelated');
      await embedAll();
      fake.embedded.length = 0;
      const unrelated = await select(target, 'quantum chromodynamics lecture');
      // Searched by meaning, but nothing is similar enough: no passage, no note.
      expect(fake.embedded).toEqual(['quantum chromodynamics lecture']);
      expect(unrelated.search?.passages).toEqual([]);
      expect(unrelated.searchPart).toBeNull();

      const scope = { userId: owner, projectId: target.id, fileIds: [notes.id, stock.id] };
      const generation = await current();
      const nearest = async (text: string) =>
        vectorRankProjectChunks(
          scope,
          generation,
          (await fake.doEmbed({ values: [text] })).embeddings[0]!,
          50,
        );
      expect(await nearest('quantum chromodynamics lecture')).toEqual([]);
      // A related question gets the passages about the boiler only, not the
      // kitchen notes or the ledger that a top-k search would also return.
      const related = await nearest(QUESTION);
      expect(related.length).toBeGreaterThan(0);
      expect(related[0]!.content).toContain(TARGET);
      for (const chunk of related) expect(chunk.content).toMatch(/boiler/i);
    });

    it('falls back to keyword search when the embeddings call fails, and backs failing files off', async () => {
      const { project: target, notes } = await largeProject('Failing');
      await embedAll();
      fake.failWith = new Error('provider down');

      const selection = await select(target, QUESTION);
      expect(selection.searchPart).toBeNull();
      expect(passageText(selection)).not.toContain(TARGET);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: target.id }),
        'Meaning-based project search failed; using keyword search only',
      );

      // A failing file is recorded and skipped until its retry time.
      const extra = await projectFile(target.id, 'extra.txt', ledger('Extra'));
      expect(await embedPendingProjectPassages()).toBe(0);
      const [failure] = await pool.db
        .select()
        .from(schema.embeddingGenerationFailure)
        .where(eq(schema.embeddingGenerationFailure.attachmentId, extra.id));
      expect(failure).toMatchObject({
        generationId: 1,
        failures: 1,
        lastError: 'provider down',
      });
      expect(failure!.retryAt.getTime()).toBeGreaterThan(Date.now());
      expect((await embeddingsStatus()).failures).toEqual({ files: 1, lastError: 'provider down' });
      expect(await embeddingsHealthCheck()).toMatchObject({ status: 'warn' });
      fake.failWith = null;
      expect(await embedPendingProjectPassages()).toBe(0);

      // Due again: retried, and a second failure doubles the wait.
      await pool.db.execute(
        sql`update embedding_generation_failure set retry_at = now() - interval '1 second'`,
      );
      fake.failWith = new Error('still down');
      await embedPendingProjectPassages();
      const [second] = await pool.db.select().from(schema.embeddingGenerationFailure);
      expect(second).toMatchObject({ failures: 2, lastError: 'still down' });
      expect(second!.retryAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

      // An upload never fails because embedding does.
      const uploaded = await projectFile(target.id, 'upload.txt', ledger('Upload'), {
        index: false,
      });
      await expect(indexUploadedProjectFile(uploaded.id)).resolves.toBeUndefined();
      expect(await chunkContents(uploaded.id)).not.toEqual([]);

      // Once working, the backed-off file is embedded when due and its record cleared.
      fake.failWith = null;
      await pool.db.execute(
        sql`update embedding_generation_failure set retry_at = now() - interval '1 second'`,
      );
      expect(await embedAll()).toBeGreaterThan(0);
      expect(await pool.db.select().from(schema.embeddingGenerationFailure)).toEqual([]);
      expect((await embeddingRows()).some((row) => row.attachment_id === notes.id)).toBe(true);
    });

    it('rebuilds in a new generation when the model changes, and keeps searching the current one meanwhile', async () => {
      const { project: target, notes, stock } = await largeProject('Changing');
      const total = (await chunkContents(notes.id)).length + (await chunkContents(stock.id)).length;
      await embedAll();
      expect((await select(target, QUESTION)).searchPart?.data.ranking).toBe('hybrid');

      // Same dimensions, new model: a second generation, filled in the background.
      await configure({ modelId: 'fake-embed-2' });
      const { current: first, filling: second } = await resolveGenerations({ fresh: true });
      expect(first).toMatchObject({ id: 1, modelKey: 'fake-provider/fake-embed/16' });
      expect(second).toMatchObject({
        id: 2,
        tableName: 'project_file_embedding_g2',
        state: 'filling',
        modelKey: 'fake-provider/fake-embed-2/16',
      });
      // Searches keep using generation 1, and its vectors are untouched.
      const meanwhile = await select(target, QUESTION);
      expect(meanwhile.searchPart?.data.ranking).toBe('hybrid');
      expect(passageText(meanwhile)).toContain(TARGET);
      expect(await embedAll()).toBe(0);
      expect(await fillGeneration(second!, { deadline: Date.now() + 60_000, pauseMs: 0 })).toBe(
        total,
      );
      expect(await embeddingRows()).toHaveLength(total);
      const [filled] = await pool.db.execute<{ rows: number; keys: string[] }>(
        sql`select count(*)::int as rows, array_agg(distinct model_key) as keys from project_file_embedding_g2`,
      );
      expect(filled).toEqual({ rows: total, keys: ['fake-provider/fake-embed-2/16'] });
      const status = await embeddingsStatus();
      expect(status).toMatchObject({
        active: true,
        storageDimensions: 16,
        settings: { modelId: 'fake-embed-2', dimensions: 16 },
        pgvector: { state: 'enabled', version: expect.any(String) },
        passages: { embedded: total, total },
        generations: {
          current: { id: 1, modelId: 'fake-embed', passages: { total, embedded: total } },
          filling: { id: 2, modelId: 'fake-embed-2', passages: { total, embedded: total } },
        },
      });
      expect(await embeddingsHealthCheck()).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining(
          `${total} of ${total} passages embedded with fake-embed; rebuilding for fake-embed-2: ${total} of ${total}`,
        ),
      });

      // A model returning the wrong size is refused, never stored.
      fake = fakeEmbeddingModel({ modelId: 'fake-embed', dimensions: 5 });
      state.fake = fake;
      expect((await select(target, QUESTION)).searchPart).toBeNull();
      expect(
        await semanticProjectChunks(
          { userId: owner, projectId: target.id, fileIds: [notes.id] },
          QUESTION,
          10,
        ),
      ).toBeNull();
    });

    it('never searches another person’s or another project’s embeddings', async () => {
      const mine = await largeProject('Own');
      const sibling = await project('Sibling');
      const siblingFile = await projectFile(
        sibling.id,
        'sibling.txt',
        paragraph('SIBLING_MARKER greenhouse heater startup password conservatory boiler ignition'),
      );
      const stranger = await seedUser(pool.db, state.organizationId);
      const theirs = await project('Stranger', stranger);
      const foreign = await projectFile(
        theirs.id,
        'theirs.txt',
        paragraph(
          'STRANGER_MARKER greenhouse heater startup password conservatory boiler ignition',
        ),
        { userId: stranger },
      );
      await embedAll();

      const selection = await select(mine.project, QUESTION);
      expect(passageText(selection)).toContain(TARGET);
      expect(passageText(selection)).not.toMatch(/SIBLING_MARKER|STRANGER_MARKER/);

      // The vector query re-checks owner and project even for ids it is handed.
      const scope = {
        userId: owner,
        projectId: mine.project.id,
        fileIds: [siblingFile.id, foreign.id, mine.notes.id],
      };
      const generation = await current();
      const nearest = await vectorRankProjectChunks(
        scope,
        generation,
        (await fake.doEmbed({ values: [QUESTION] })).embeddings[0]!,
        50,
      );
      expect(nearest.length).toBeGreaterThan(0);
      expect(new Set(nearest.map((chunk) => chunk.attachmentId))).toEqual(new Set([mine.notes.id]));
      expect(nearest[0]!.content).toContain(TARGET);
      expect(await vectorRankProjectChunks({ ...scope, fileIds: [] }, generation, [1], 5)).toEqual(
        [],
      );
      expect(await semanticProjectChunks({ ...scope, fileIds: [] }, QUESTION, 5)).toBeNull();
      expect(await semanticProjectChunks(scope, '   ', 5)).toBeNull();
    });
  });
});
