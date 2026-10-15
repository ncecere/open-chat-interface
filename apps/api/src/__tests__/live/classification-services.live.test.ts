import { type createDatabase, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { classificationData } from '../../../test/classification-data.js';
import { type FakeEmbeddingModel, fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import { type FakeReranker, startFakeReranker } from '../../../test/fake-reranker.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';
import {
  createHybridDatabases,
  destroyHybridDatabases,
  facilities,
  hybridHelpers,
} from '../../../test/project-search-hybrid.fixtures.js';

/**
 * Data classification (#395) at the three outside services that see project
 * content: query embedding (i), reranking (j) and embedding project files (k).
 * A fake embeddings model and a fake reranking server count what they receive:
 * zero when the project's classes are not approved for the service, and exactly
 * what the feature needs when they are.
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
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { loadClasses } = await import('../../services/classification/resolve.js');
const { encryptSecret } = await import('../../lib/crypto.js');
const { embedPendingProjectPassages, embedUploadedProjectFile } = await import(
  '../../services/project-search/embedding.js'
);

/** Keyword and meaning both find the answer, so hybrid ranking and reranking have work to do. */
const QUESTION = 'conservatory boiler ignition passphrase';

describe.skipIf(!available)('live data classification: outside services', () => {
  let databases: Awaited<ReturnType<typeof createHybridDatabases>>;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let fake: FakeEmbeddingModel;
  let reranker: FakeReranker;
  let data: ReturnType<typeof classificationData>;
  let student: string;
  let rerankProvider = '';
  const helpers = hybridHelpers(state, () => ({ pool, owner }));

  const mode = async (
    value: 'off' | 'warn' | 'block',
    services: Partial<Record<'embeddings' | 'reranking', string[]>> = {},
  ) => {
    await updateSetting('classification', {
      mode: value,
      services: { webSearch: [], embeddings: [], reranking: [], ...services },
    });
    invalidateSettingsCache('classification');
  };
  async function turnClassification(projectId: string) {
    const stored = await import('../../services/classification/config.js');
    return {
      mode: (await stored.classificationSettings()).mode,
      classes: await loadClasses({ projectId }),
    };
  }
  async function labelledProject(name: string, labelled = true) {
    const { project, notes, stock } = await helpers.largeProject(name);
    if (labelled)
      await data.run(
        sql`insert into project_data_class (project_id, data_class_id) values (${project.id}, ${student})`,
      );
    return { project, notes, stock };
  }
  const vectorsFor = async (attachmentId: string) =>
    (await helpers.embeddingRows()).filter((row) => row.attachment_id === attachmentId).length;
  async function configureReranking() {
    await updateSetting('reranking', {
      enabled: true,
      providerId: rerankProvider,
      modelId: 'bge-reranker-v2-m3',
      searchPriceMicros: null,
    });
    invalidateSettingsCache('reranking');
  }

  beforeAll(async () => {
    databases = await createHybridDatabases(state);
    pool = databases.vectorPool;
    owner = databases.owner;
    state.db = pool.db;
    data = classificationData(pool, state.organizationId, owner);
    reranker = await startFakeReranker();
    const [row] = await pool.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai-compatible',
        label: 'Local reranker',
        baseUrl: reranker.baseUrl,
        encryptedApiKey: encryptSecret('sk-local-rerank-key'),
      })
      .returning({ id: schema.provider.id });
    rerankProvider = row!.id;
  });
  beforeEach(async () => {
    fake = fakeEmbeddingModel();
    state.fake = fake;
    reranker.requests.length = 0;
    reranker.mode = 'ok';
    reranker.score = (_query, document) => (document.includes('AMBER-SEVEN') ? 0.98 : 0.02);
    await pool.db.execute(sql`delete from project`);
    await pool.db.execute(sql`delete from usage_event`);
    await pool.db.execute(sql`delete from usage_record`);
    await pool.db.execute(sql`delete from data_class`);
    await helpers.resetGenerations();
    await helpers.configure({});
    await mode('off');
    student = await data.dataClass('Student');
  });
  afterAll(async () => {
    await reranker?.close();
    await destroyHybridDatabases(
      { plain: databases?.plain, vector: databases?.vector },
      { plainPool: databases?.plainPool, vectorPool: databases?.vectorPool },
    );
  });

  describe('i. the question sent to the embeddings provider', () => {
    it('is not embedded for a project whose class is not approved: keyword search only, and the note says so', async () => {
      const { project } = await labelledProject('Records');
      await helpers.embedAll();
      const embeddedBefore = fake.embedded.length;
      await mode('block');
      const selection = await helpers.select(
        project,
        QUESTION,
        await turnClassification(project.id),
      );
      expect(fake.embedded).toHaveLength(embeddedBefore);
      expect(selection.searchPart?.data).toMatchObject({
        ranking: 'keyword',
        withheld: ['embeddings'],
      });
    });

    it('is embedded once when the class is approved for embeddings, and when nothing is labelled', async () => {
      const { project } = await labelledProject('Records');
      await helpers.embedAll();
      const embeddedBefore = fake.embedded.length;
      await mode('block', { embeddings: [student] });
      const approved = await helpers.select(
        project,
        QUESTION,
        await turnClassification(project.id),
      );
      expect(fake.embedded).toHaveLength(embeddedBefore + 1);
      expect(approved.searchPart?.data).toMatchObject({ ranking: 'hybrid' });
      expect(approved.searchPart?.data).not.toHaveProperty('withheld');

      await mode('block');
      const { project: plain } = await labelledProject('Plain', false);
      await helpers.embedAll();
      const before = fake.embedded.length;
      const unlabelled = await helpers.select(plain, QUESTION, await turnClassification(plain.id));
      expect(fake.embedded).toHaveLength(before + 1);
      expect(unlabelled.searchPart?.data).toMatchObject({ ranking: 'hybrid' });
    });

    it('warn embeds as before and records what block would have refused', async () => {
      const { project } = await labelledProject('Records');
      await helpers.embedAll();
      const embeddedBefore = fake.embedded.length;
      await mode('warn');
      const selection = await helpers.select(
        project,
        QUESTION,
        await turnClassification(project.id),
      );
      expect(fake.embedded).toHaveLength(embeddedBefore + 1);
      expect(selection.searchPart?.data).toMatchObject({ ranking: 'hybrid' });
      const warned = await pool.db.execute(
        sql`select metadata from audit_log where action = 'classification.warn'`,
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]?.metadata).toMatchObject({ point: 'embedding', destination: 'embeddings' });
    });
  });

  describe('j. the question and passages sent to the reranker', () => {
    it('are not sent for a project whose class is not approved: the fused order stays', async () => {
      const { project } = await labelledProject('Records');
      await helpers.embedAll();
      await configureReranking();
      await mode('block', { embeddings: [student] });
      const selection = await helpers.select(
        project,
        QUESTION,
        await turnClassification(project.id),
      );
      expect(reranker.requests).toHaveLength(0);
      expect(selection.searchPart?.data).toMatchObject({
        reranked: false,
        withheld: ['reranking'],
      });
    });

    it('are sent once when the class is approved for reranking', async () => {
      const { project } = await labelledProject('Records');
      await helpers.embedAll();
      await configureReranking();
      await mode('block', { embeddings: [student], reranking: [student] });
      const selection = await helpers.select(
        project,
        QUESTION,
        await turnClassification(project.id),
      );
      expect(reranker.requests).toHaveLength(1);
      expect(selection.searchPart?.data).toMatchObject({ reranked: true });
      expect(selection.searchPart?.data).not.toHaveProperty('withheld');
    });
  });

  describe('k. embedding project files', () => {
    it('leaves the files of a labelled project out in block, without starving the others', async () => {
      const labelled = await labelledProject('Records');
      const open = await labelledProject('Open', false);
      await mode('block');
      // A page smaller than the labelled project's passages: were they not left
      // out of what is read, they would fill it and the open project would wait.
      const stored = await embedPendingProjectPassages(8);
      expect(stored).toBe(8);
      expect(await vectorsFor(labelled.notes.id)).toBe(0);
      expect(await vectorsFor(labelled.stock.id)).toBe(0);
      expect((await vectorsFor(open.notes.id)) + (await vectorsFor(open.stock.id))).toBe(8);
      await helpers.embedAll();
      expect(await vectorsFor(labelled.notes.id)).toBe(0);
      expect(await vectorsFor(labelled.stock.id)).toBe(0);
      const chunksOfLabelled = (await helpers.chunkContents(labelled.notes.id)).length;
      expect(chunksOfLabelled).toBeGreaterThan(0);
      // Only the open project's passages ever reached the provider (the two
      // projects hold the same text, so what was sent is counted).
      const openPassages =
        (await helpers.chunkContents(open.notes.id)).length +
        (await helpers.chunkContents(open.stock.id)).length;
      expect(fake.embedded).toHaveLength(openPassages);

      // Approved for embeddings: the same files are embedded afterwards.
      await mode('block', { embeddings: [student] });
      await helpers.embedAll();
      expect(await vectorsFor(labelled.notes.id)).toBe(chunksOfLabelled);
    });

    it('an upload into a labelled project is not embedded either, and warn embeds everything', async () => {
      await mode('block');
      const { project } = await labelledProject('Records');
      const file = await helpers.projectFile(project.id, 'extra.txt', facilities());
      await embedUploadedProjectFile(file.id);
      expect(fake.embedded).toEqual([]);
      expect(await vectorsFor(file.id)).toBe(0);

      await mode('warn');
      await helpers.embedAll();
      expect(fake.embedded.length).toBeGreaterThan(0);
      expect(await vectorsFor(file.id)).toBeGreaterThan(0);
    });

    it('checks again at the file: a label that arrived after the passages were read stops the call', async () => {
      const { project, stock } = await labelledProject('Racy', false);
      await mode('block');
      const { vectorStore } = await import('../../services/vector-store/index.js');
      const store = vectorStore();
      const generation = await helpers.current();
      await store.ensureStorage(generation);
      // The page as read while the project was still unlabelled.
      const stale = await store.pendingPassages(generation, { limit: 4 });
      expect(stale.length).toBeGreaterThan(0);
      await data.run(
        sql`insert into project_data_class (project_id, data_class_id) values (${project.id}, ${student})`,
      );
      vi.spyOn(store, 'pendingPassages').mockResolvedValueOnce(stale);
      expect(await embedPendingProjectPassages(4)).toBe(0);
      expect(await vectorsFor(stock.id)).toBe(0);
      expect(fake.embedded).toEqual([]);
      // The same read, unmocked, no longer returns them.
      expect(await store.pendingPassages(generation, { limit: 4, approvedClassIds: [] })).toEqual(
        [],
      );
    });
  });
});
