import { eq, schema, sql } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EmbeddingGenerationsContext,
  ledger,
  PROVIDER,
  QUESTION,
  useEmbeddingGenerationsSuite,
} from '../../../test/embedding-generations.fixtures.js';
import { fakeVector } from '../../../test/fake-embeddings.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Embedding generations and the vector store (v0.11 design, sections 7 and 8)
 * against real PostgreSQL with pgvector and deterministic fake embeddings
 * models: new passages go to both generations, deletes reach every
 * generation, an interrupted fill resumes without loss or duplication, and the
 * store's person-and-project filter cannot be bypassed.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  fakes: {} as Record<string, unknown>,
  pressure: null as string | null,
  /** Pressure appears after this many checks; null: never. */
  pressureAfter: null as number | null,
  pressureChecks: 0,
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
vi.mock('../../services/embeddings/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/embeddings/model.js')>()),
  resolveEmbeddingModel: async (_providerId: string, modelId: string) => {
    const fake = state.fakes[modelId];
    if (!fake) throw new Error(`No fake model ${modelId}`);
    return fake;
  },
}));
vi.mock('../../services/migrations/throttle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/migrations/throttle.js')>()),
  databasePressure: async () => {
    state.pressureChecks += 1;
    if (state.pressureAfter !== null && state.pressureChecks > state.pressureAfter) return 'busy';
    return state.pressure;
  },
}));

const available = await livePostgresAvailable();
const { indexUploadedProjectFile } = await import('../../services/project-search/indexing.js');
const { embedPendingProjectPassages, fillGeneration } = await import(
  '../../services/project-search/embedding.js'
);
const { resolveGenerations } = await import('../../services/embeddings/generations.js');
const { runEmbeddingRebuild } = await import('../../services/embeddings/rebuild.js');
const { vectorStore, VectorScopeError } = await import('../../services/vector-store/index.js');

describe.skipIf(!available)('live: embedding generations', () => {
  const suite = useEmbeddingGenerationsSuite(state);
  const { configure, project, projectFile, facilitiesProject, livePassages, rows, embedAll } =
    suite;
  let pool: EmbeddingGenerationsContext['pool'];
  let owner: EmbeddingGenerationsContext['owner'];
  let stranger: EmbeddingGenerationsContext['stranger'];
  let modelB: EmbeddingGenerationsContext['modelB'];
  beforeAll(() => {
    ({ pool, owner } = suite.ctx);
  });
  beforeEach(() => {
    ({ stranger, modelB } = suite.ctx);
  });

  it('writes passages of files uploaded during a rebuild to both generations', async () => {
    const target = await project('Uploads');
    await projectFile(target.id, 'old.txt', ledger('Old'));
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const fresh = await projectFile(target.id, 'fresh.txt', ledger('Fresh'), { index: false });
    await indexUploadedProjectFile(fresh.id);
    const chunks = (
      await pool.db
        .select()
        .from(schema.projectFileChunk)
        .where(eq(schema.projectFileChunk.attachmentId, fresh.id))
    ).length;
    expect(chunks).toBeGreaterThan(0);
    const ofFile = sql`attachment_id = ${fresh.id}`;
    expect(await rows('project_file_embedding', ofFile)).toBe(chunks);
    expect(await rows('project_file_embedding_g2', ofFile)).toBe(chunks);
    expect(
      await rows('project_file_embedding_g2', sql`model_key = ${`${PROVIDER}/model-b/12`}`),
    ).toBe(chunks);
    // The current generation's job has nothing left; the rebuild fills the rest.
    expect(await embedPendingProjectPassages()).toBe(0);
    const { filling } = await resolveGenerations();
    expect(await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 })).toBe(
      (await livePassages()) - chunks,
    );
  });

  it('deletes vectors from every generation, whoever deletes the passage', async () => {
    const mine = await facilitiesProject('Mine');
    const other = await facilitiesProject('Other');
    const theirs = await facilitiesProject('Theirs', stranger);
    const spare = await facilitiesProject('Spare');
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    await runEmbeddingRebuild(10_000);
    const tables = ['project_file_embedding', 'project_file_embedding_g2'];
    const count = async (where = sql`true`) =>
      Promise.all(tables.map((table) => rows(table, where)));
    const ofFile = (id: string) => sql`attachment_id = ${id}`;
    const before = await count(ofFile(mine.notes.id));
    expect(before[0]).toBeGreaterThan(0);
    expect(before[1]).toBe(before[0]);

    // A file removed (its row deleted: trash purge, retention, legal hold release).
    await pool.db.delete(schema.attachment).where(eq(schema.attachment.id, mine.notes.id));
    expect(await count(ofFile(mine.notes.id))).toEqual([0, 0]);
    // A project deleted.
    await pool.db.delete(schema.project).where(eq(schema.project.id, other.project.id));
    expect(await count(ofFile(other.notes.id))).toEqual([0, 0]);
    expect(await count(ofFile(other.stock.id))).toEqual([0, 0]);
    // An account deleted.
    await pool.db.delete(schema.user).where(eq(schema.user.id, stranger));
    expect(await count(ofFile(theirs.notes.id))).toEqual([0, 0]);

    // The store's own deletes reach every generation too.
    const store = vectorStore();
    const stockRows = (await count(ofFile(mine.stock.id)))[0]!;
    expect(await store.deleteByPassage([{ attachmentId: mine.stock.id, ordinal: 0 }])).toBe(2);
    expect(await count(ofFile(mine.stock.id))).toEqual([stockRows - 1, stockRows - 1]);
    expect(await store.deleteByFile([mine.stock.id])).toBe(2 * (stockRows - 1));
    expect(await count(ofFile(mine.stock.id))).toEqual([0, 0]);
    const spareRows = (await count(ofFile(spare.notes.id)))[0]!;
    await store.deleteByProject(spare.project.id);
    expect(await count(ofFile(spare.notes.id))).toEqual([0, 0]);
    expect(spareRows).toBeGreaterThan(0);
    expect(await store.deleteByPerson(owner)).toBe(0);
    await facilitiesProject('Again');
    await embedAll();
    expect((await count())[0]).toBeGreaterThan(0);
    await pool.db.transaction(async (tx) => {
      expect(await store.deleteByPerson(owner, tx)).toBeGreaterThan(0);
    });
    expect(await count()).toEqual([0, 0]);
  });

  it('resumes a fill cut off mid-batch without losing or repeating a passage', async () => {
    const target = await project('Crash');
    for (let index = 0; index < 5; index += 1) {
      await projectFile(target.id, `file-${index}.txt`, ledger(`File${index}`));
    }
    const total = await livePassages();
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const { filling } = await resolveGenerations({ fresh: true });

    // The replica dies while writing its third batch: embedded, never stored.
    const store = vectorStore();
    const upsert = store.upsert.bind(store);
    let calls = 0;
    let lost: string[] = [];
    const spy = vi.spyOn(store, 'upsert').mockImplementation(async (generation, passages) => {
      calls += 1;
      if (calls === 3) {
        lost = passages.map((passage) => `${passage.attachmentId}:${passage.ordinal}`);
        return new Promise<void>(() => {});
      }
      return upsert(generation, passages);
    });
    void fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 });
    await vi.waitFor(() => expect(calls).toBe(3));
    spy.mockRestore();
    const stored = await rows('project_file_embedding_g2');
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(total);
    expect(lost.length).toBeGreaterThan(0);

    // Another replica's run carries on from what is missing.
    const embeddedBefore = modelB.embedded.length;
    expect(await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 })).toBe(
      total - stored!,
    );
    const [check] = await pool.db.execute<{ rows: number; passages: number }>(sql`
      select count(*)::int as rows,
             count(distinct (attachment_id, ordinal))::int as passages
      from project_file_embedding_g2
    `);
    expect(check).toEqual({ rows: total, passages: total });
    expect(await vectorStore().covers(filling!)).toBe(true);
    // Only the batch in flight was embedded twice; nothing stored was redone.
    expect(modelB.embedded.length).toBe(total + lost.length);
    expect(modelB.embedded.length - embeddedBefore).toBe(total - stored!);
    expect(new Set(modelB.embedded).size).toBe(total);
  });

  it('enforces the person-and-project filter inside the store', async () => {
    const mine = await facilitiesProject('Mine');
    const sibling = await facilitiesProject('Sibling');
    const theirs = await facilitiesProject('Theirs', stranger);
    await configure('model-a', 16);
    await embedAll();
    const { current } = await resolveGenerations();
    const store = vectorStore();
    const vector = fakeVector(QUESTION, 16);
    const search = (scope: unknown) =>
      store.search(current!, scope as Parameters<typeof store.search>[1], vector, 50);

    for (const scope of [
      undefined,
      {},
      { personId: owner },
      { projectId: mine.project.id },
      { personId: '', projectId: mine.project.id },
      { personId: owner, projectId: '   ' },
      { personId: owner, projectId: mine.project.id, fileIds: 'all' },
      { personId: null, projectId: null },
    ]) {
      await expect(search(scope)).rejects.toBeInstanceOf(VectorScopeError);
      await expect(
        store.hasVectors(current!, scope as Parameters<typeof store.hasVectors>[1]),
      ).rejects.toBeInstanceOf(VectorScopeError);
    }

    const files = (hits: Array<{ attachmentId: string }>) =>
      new Set(hits.map((hit) => hit.attachmentId));
    const own = await search({ personId: owner, projectId: mine.project.id });
    expect(files(own)).toEqual(new Set([mine.notes.id, mine.stock.id]));
    // Another person's project, another project of mine, foreign file ids.
    expect(await search({ personId: owner, projectId: theirs.project.id })).toEqual([]);
    expect(await search({ personId: stranger, projectId: mine.project.id })).toEqual([]);
    expect(
      files(
        await search({
          personId: owner,
          projectId: mine.project.id,
          fileIds: [theirs.notes.id, sibling.notes.id, mine.notes.id],
        }),
      ),
    ).toEqual(new Set([mine.notes.id]));
    expect(
      await search({
        personId: owner,
        projectId: mine.project.id,
        fileIds: [theirs.notes.id, sibling.stock.id],
      }),
    ).toEqual([]);
    expect(
      await store.hasVectors(current!, {
        personId: owner,
        projectId: mine.project.id,
        fileIds: [theirs.notes.id],
      }),
    ).toBe(false);
    expect(await search({ personId: `x' or '1'='1`, projectId: `x' or '1'='1` })).toEqual([]);
    expect(await search({ personId: owner, projectId: mine.project.id, fileIds: [] })).toEqual([]);
    // A file in the trash is not searched.
    await pool.db
      .update(schema.attachment)
      .set({ deletedAt: new Date() })
      .where(eq(schema.attachment.id, mine.notes.id));
    expect(files(await search({ personId: owner, projectId: mine.project.id }))).toEqual(
      new Set([mine.stock.id]),
    );
    // A query vector of the wrong size never reaches the database.
    await expect(
      store.search(current!, { personId: owner, projectId: mine.project.id }, [1, 2], 5),
    ).rejects.toThrow(RangeError);
  });
});
