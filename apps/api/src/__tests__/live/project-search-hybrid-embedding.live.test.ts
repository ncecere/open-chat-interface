import { randomUUID } from 'node:crypto';
import { type createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeEmbeddingModel,
  fakeEmbeddingModel,
  words,
} from '../../../test/fake-embeddings.js';
import { type LiveDatabase, livePostgresAvailable, seedUser } from '../../../test/live-postgres.js';
import {
  createHybridDatabases,
  destroyHybridDatabases,
  hybridHelpers,
  ledger,
  paragraph,
  QUESTION,
} from '../../../test/project-search-hybrid.fixtures.js';

/**
 * Meaning-based search for project files (v0.9) against real PostgreSQL with
 * pgvector: keyword-only behaviour while the extension is absent, the runtime
 * embedding table, the background job, hybrid ranking with a deterministic
 * fake embeddings model, fallbacks, usage attribution and isolation.
 * This suite covers keyword-only search without pgvector, the embedding table and job,
 * usage attribution and resolving the configured provider; the shared fixtures live in
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
const { embedPendingProjectPassages, EMBED_BATCH } = await import(
  '../../services/project-search/embedding.js'
);
const { pgvectorInfo } = await import('../../services/embeddings/storage.js');
const { vectorStore } = await import('../../services/vector-store/index.js');
const { resolveEmbeddingModel } = await import('../../services/embeddings/model.js');
const { embeddingsStatus, embeddingsHealthCheck } = await import(
  '../../services/embeddings/status.js'
);
const { encryptSecret } = await import('../../lib/crypto.js');

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
    project,
    projectFile,
    resetGenerations,
    select,
    usageEvents,
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

  describe('without pgvector', () => {
    beforeAll(() => useDatabase('plain'));

    it('stays keyword-only, exactly as before, even with an embeddings model configured', async () => {
      expect(await pgvectorInfo()).toEqual({ state: 'available', version: null, schema: null });
      expect(await vectorStore().health()).toEqual({
        kind: 'pgvector',
        state: 'available',
        version: null,
      });
      const { project: target } = await largeProject('Plain');

      await configure({ enabled: false });
      const before = await select(target, QUESTION);
      const keyword = await select(target, 'conservatory boiler ignition');
      await configure({ enabled: true });
      const after = await select(target, QUESTION);
      const keywordAfter = await select(target, 'conservatory boiler ignition');

      // The paraphrase finds nothing by keyword, so no passage is used.
      expect(after.search).toEqual(before.search);
      expect(after.search?.passages).toEqual([]);
      expect(after.searchPart).toBeNull();
      expect(before.searchPart).toBeNull();
      expect(keywordAfter.search).toEqual(keyword.search);
      expect(keywordAfter.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'keyword' });

      // Nothing was embedded, created or charged, and nothing was logged as failing.
      expect(fake.embedded).toEqual([]);
      expect(await embedPendingProjectPassages()).toBe(0);
      const [table] = await pool.db.execute<{ found: string | null }>(
        sql`select to_regclass('project_file_embedding')::text as found`,
      );
      expect(table?.found).toBeNull();
      expect(await usageEvents(owner)).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
      await expect(vectorStore().ensureStorage(await current())).rejects.toThrow(
        'pgvector extension is not enabled',
      );
      expect(await vectorStore().storageState(await current())).toBe('unavailable');
    });

    it('reports the extension as installed but not enabled', async () => {
      await configure({ enabled: true });
      const status = await embeddingsStatus();
      expect(status).toMatchObject({
        pgvector: { state: 'available', version: null },
        active: false,
        storageDimensions: null,
      });
      expect(await embeddingsHealthCheck()).toMatchObject({
        id: 'embeddings',
        status: 'warn',
        detail: expect.stringContaining('CREATE EXTENSION vector'),
      });
      await configure({ enabled: false });
      expect(await embeddingsHealthCheck()).toMatchObject({
        status: 'ok',
        detail: 'Off; keyword search only. pgvector installed but not enabled.',
      });
    });
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

    it('creates the embedding table once, safely under concurrency, and re-creates it for new dimensions only when asked', async () => {
      const store = vectorStore();
      const generation = await current();
      // Generation 1 keeps the name v0.10 uses.
      expect(generation).toMatchObject({
        id: 1,
        tableName: 'project_file_embedding',
        state: 'current',
      });
      await pool.db.execute(sql`drop table if exists project_file_embedding`);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.ensureStorage(generation)),
      );
      expect(results.filter((result) => result === 'created')).toHaveLength(1);
      expect(results.filter((result) => result === 'ready')).toHaveLength(5);
      expect(await store.storageState(generation)).toBe('ready');
      expect(await store.ensureStorage(generation)).toBe('ready');
      // Storage of another size is left alone unless replacing it is asked for.
      const smaller = { ...generation, dimensions: 8 };
      expect(await store.ensureStorage(smaller)).toBe('mismatch');
      expect(await store.storageState(smaller)).toBe('mismatch');
      const changed = await Promise.all([
        store.ensureStorage(smaller, { replaceMismatched: true }),
        store.ensureStorage(smaller, { replaceMismatched: true }),
      ]);
      expect(changed.sort()).toEqual(['ready', 'recreated']);
      expect(await store.storageState(generation)).toBe('mismatch');
      expect(await store.ensureStorage(generation, { replaceMismatched: true })).toBe('recreated');
      for (const dimensions of [0, 16001, 1.5]) {
        await expect(store.ensureStorage({ ...generation, dimensions })).rejects.toThrow(
          RangeError,
        );
      }
    });

    it('embeds passages in bounded, per-file batches and carries on after a restart', async () => {
      const { notes, stock } = await largeProject('Batches');
      const total = (await chunkContents(notes.id)).length + (await chunkContents(stock.id)).length;
      expect(total).toBeGreaterThan(5);

      expect(await embedPendingProjectPassages(3)).toBe(3);
      expect(await embedPendingProjectPassages(3)).toBe(3);
      // A "restart": the next run only picks up what is missing.
      expect(await embedAll()).toBe(total - 6);
      expect(await embedPendingProjectPassages()).toBe(0);

      expect(fake.embedded).toHaveLength(total);
      expect(new Set(fake.embedded).size).toBe(total);
      const rows = await embeddingRows();
      expect(rows).toHaveLength(total);
      expect(new Set(rows.map((row) => row.model_key))).toEqual(
        new Set(['fake-provider/fake-embed/16']),
      );
      for (const call of fake.doEmbedCalls) {
        expect(call.values.length).toBeLessThanOrEqual(EMBED_BATCH);
      }
      // No request mixes two files: every value of a call comes from one file.
      const notesChunks = new Set(await chunkContents(notes.id));
      for (const call of fake.doEmbedCalls) {
        const fromNotes = call.values.filter((value) => notesChunks.has(value)).length;
        expect([0, call.values.length]).toContain(fromNotes);
      }
    });

    it('splits a large file into requests of at most the batch size', async () => {
      const big = await project('Big');
      const text = Array.from({ length: 90 }, (_, index) =>
        paragraph(
          `Inventory ledger line ${index} lists stock alphabetically for the catalogue`,
          10,
        ),
      ).join('\n\n');
      const file = await projectFile(big.id, 'big.txt', text);
      const chunks = (await chunkContents(file.id)).length;
      expect(chunks).toBeGreaterThan(EMBED_BATCH);
      expect(await embedPendingProjectPassages(chunks)).toBe(chunks);
      expect(fake.doEmbedCalls.map((call) => call.values.length)).toEqual([
        EMBED_BATCH,
        chunks - EMBED_BATCH,
      ]);
    });

    it('charges passages to the file owner and questions to the person asking', async () => {
      const other = await seedUser(pool.db, state.organizationId);
      const mine = await largeProject('Mine');
      const theirs = await largeProject('Theirs', other);
      await embedAll();

      const tokensOf = async (fileIds: string[]) => {
        let tokens = 0;
        for (const id of fileIds) {
          for (const content of await chunkContents(id)) tokens += words(content).length;
        }
        return tokens;
      };
      const ownerEvents = await usageEvents(owner);
      const otherEvents = await usageEvents(other);
      const sum = (events: typeof ownerEvents) =>
        events.reduce((total, event) => total + event.tokensIn, 0);
      expect(sum(ownerEvents)).toBe(await tokensOf([mine.notes.id, mine.stock.id]));
      expect(sum(otherEvents)).toBe(await tokensOf([theirs.notes.id, theirs.stock.id]));
      for (const event of [...ownerEvents, ...otherEvents]) {
        expect(event).toMatchObject({
          modelSlug: 'embedding:fake-embed',
          messageCount: 0,
          tokensOut: 0,
          costMicros: 0,
          pending: false,
          usageUnknown: false,
        });
      }

      // The question is charged to the asker, at the configured price.
      await configure({ inputPriceMicros: 2_000_000 });
      const selection = await select(mine.project, QUESTION);
      expect(selection.searchPart?.data.ranking).toBe('hybrid');
      const question = (await usageEvents(owner)).find((event) => event.inputPriceMicros !== null);
      expect(question).toMatchObject({
        modelSlug: 'embedding:fake-embed',
        tokensIn: words(QUESTION).length,
        messageCount: 0,
        inputPriceMicros: 2_000_000,
        costMicros: Math.ceil((2_000_000 * words(QUESTION).length) / 1_000_000),
      });
      expect(await usageEvents(other)).toHaveLength(otherEvents.length);
      const [rollup] = await pool.db
        .select()
        .from(schema.usageRecord)
        .where(eq(schema.usageRecord.userId, owner));
      expect(rollup).toMatchObject({
        modelSlug: 'embedding:fake-embed',
        messageCount: 0,
        tokensIn: sum(ownerEvents) + words(QUESTION).length,
      });
    });

    it('stops a run after repeated failures, so a provider outage is not hammered', async () => {
      const many = await project('Many');
      for (let index = 0; index < 5; index += 1) {
        await projectFile(many.id, `file-${index}.txt`, ledger(`File${index}`));
      }
      fake.failWith = new Error('outage');
      expect(await embedPendingProjectPassages()).toBe(0);
      expect(fake.doEmbedCalls).toHaveLength(3);
      expect(await pool.db.select().from(schema.embeddingGenerationFailure)).toHaveLength(3);
    });

    it('embeds an uploaded file straight away when storage is ready', async () => {
      const target = await project('Uploads');
      await vectorStore().ensureStorage(await current());
      const file = await projectFile(target.id, 'fresh.txt', ledger('Fresh'), { index: false });
      await indexUploadedProjectFile(file.id);
      const rows = (await embeddingRows()).filter((row) => row.attachment_id === file.id);
      expect(rows).toHaveLength((await chunkContents(file.id)).length);

      // Off: an upload embeds nothing.
      await configure({ enabled: false });
      const off = await projectFile(target.id, 'off.txt', ledger('Off'), { index: false });
      await indexUploadedProjectFile(off.id);
      expect((await embeddingRows()).filter((row) => row.attachment_id === off.id)).toEqual([]);
    });
  });

  describe('resolving the configured provider', () => {
    beforeAll(() => useDatabase('vector'));
    beforeEach(() => {
      state.fake = null;
    });

    async function provider(values: Partial<typeof schema.provider.$inferInsert>) {
      const [row] = await pool.db
        .insert(schema.provider)
        .values({ organizationId: state.organizationId, kind: 'openai', label: 'P', ...values })
        .returning();
      return row!.id;
    }

    it('builds models for providers that can embed and refuses the rest', async () => {
      const openai = await provider({ label: 'OpenAI', encryptedApiKey: encryptSecret('sk-test') });
      const google = await provider({
        kind: 'google',
        label: 'Google',
        encryptedApiKey: encryptSecret('g-test'),
      });
      const local = await provider({
        kind: 'openai-compatible',
        label: 'Local',
        baseUrl: 'http://127.0.0.1:9/v1',
      });
      expect((await resolveEmbeddingModel(openai, 'text-embedding-3-small')).modelId).toBe(
        'text-embedding-3-small',
      );
      expect((await resolveEmbeddingModel(google, 'gemini-embedding-001')).modelId).toBe(
        'gemini-embedding-001',
      );
      expect((await resolveEmbeddingModel(local, 'nomic-embed-text')).modelId).toBe(
        'nomic-embed-text',
      );

      const anthropic = await provider({
        kind: 'anthropic',
        label: 'Claude',
        encryptedApiKey: encryptSecret('a'),
      });
      const disabled = await provider({ label: 'Off', enabled: false, encryptedApiKey: 'x' });
      const keyless = await provider({ label: 'Keyless' });
      await expect(resolveEmbeddingModel(anthropic, 'x')).rejects.toThrow(
        'Claude cannot create embeddings',
      );
      await expect(resolveEmbeddingModel(disabled, 'x')).rejects.toThrow('Off is disabled');
      await expect(resolveEmbeddingModel(keyless, 'x')).rejects.toThrow(
        'Keyless has no API key configured',
      );
      await expect(resolveEmbeddingModel(randomUUID(), 'x')).rejects.toThrow('no longer exists');
    });
  });
});
