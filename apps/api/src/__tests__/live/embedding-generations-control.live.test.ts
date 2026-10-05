import { eq, schema, sql } from '@oci/db';
import { embeddingCostMicros } from '@oci/shared';
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
 * models: cancelling, pausing and stopping a rebuild, failures that never
 * reach uploads or searches, and switches an administrator got to first.
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
const { logger } = await import('../../lib/logger.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { indexUploadedProjectFile } = await import('../../services/project-search/indexing.js');
const { fillGeneration } = await import('../../services/project-search/embedding.js');
const { applyModelChoice, cancelRebuild, resolveGenerations, switchGeneration } = await import(
  '../../services/embeddings/generations.js'
);
const { embeddingRebuildJobs, runEmbeddingRebuild } = await import(
  '../../services/embeddings/rebuild.js'
);
const { semanticProjectChunks, vectorRankProjectChunks } = await import(
  '../../services/project-search/semantic.js'
);
const { embeddingsStatus } = await import('../../services/embeddings/status.js');
const { vectorStore, GenerationStateError } = await import('../../services/vector-store/index.js');

describe.skipIf(!available)('live: embedding generations', () => {
  const suite = useEmbeddingGenerationsSuite(state);
  const {
    configure,
    project,
    projectFile,
    facilitiesProject,
    expectMeaningSearch,
    livePassages,
    rows,
    generations,
    embedAll,
    finishUpgrade,
  } = suite;
  let pool: EmbeddingGenerationsContext['pool'];
  let owner: EmbeddingGenerationsContext['owner'];
  let modelA: EmbeddingGenerationsContext['modelA'];
  let modelB: EmbeddingGenerationsContext['modelB'];
  beforeAll(() => {
    ({ pool, owner } = suite.ctx);
  });
  beforeEach(() => {
    ({ modelA, modelB } = suite.ctx);
  });

  it('cancels a rebuild and drops its table; a model chosen again within the grace period is reused', async () => {
    await finishUpgrade();
    const { project: target } = await facilitiesProject('Cancel');
    const total = await livePassages();
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const actor = { id: owner, email: 'owner@example.test' };
    await cancelRebuild(2, actor);
    await expect(cancelRebuild(2, actor)).rejects.toBeInstanceOf(GenerationStateError);
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding_g2')).toBeNull();
    expect((await generations()).map((row) => [row.id, row.state])).toEqual([
      [1, 'current'],
      [2, 'dropped'],
    ]);
    await expectMeaningSearch(target);

    // A new rebuild, switched to; then the old model chosen again within
    // generation 1's grace period reuses its vectors.
    await configure('model-b', 12);
    await runEmbeddingRebuild(10_000);
    expect((await resolveGenerations()).current?.id).toBe(3);
    const embeddedByA = modelA.embedded.length;
    await configure('model-a', 16);
    expect((await resolveGenerations()).filling).toMatchObject({ id: 1, state: 'filling' });
    await runEmbeddingRebuild(10_000);
    expect((await resolveGenerations()).current?.id).toBe(1);
    expect(modelA.embedded.length).toBe(embeddedByA);
    expect(await rows('project_file_embedding')).toBe(total);
  });

  it('pauses a rebuild while the database is under pressure, and shows its cost before a change', async () => {
    await facilitiesProject('Pressure');
    const total = await livePassages();
    await configure('model-a', 16);
    await embedAll();
    const status = await embeddingsStatus();
    expect(status.estimate.passages).toBe(total);
    const [chars] = await pool.db.execute<{ average: number }>(
      sql`select avg(char_length(content))::float8 as average from project_file_chunk`,
    );
    expect(status.estimate.averageTokens).toBe(Math.round(Number(chars!.average) / 4));
    expect(embeddingCostMicros(status.estimate, 20_000)).toBe(
      Math.ceil((total * status.estimate.averageTokens * 20_000) / 1_000_000),
    );
    expect(embeddingCostMicros(status.estimate, null)).toBeNull();

    await configure('model-b', 12);
    state.pressure = 'A transaction has been open for 7 min';
    expect(await runEmbeddingRebuild(10_000)).toBe(0);
    expect(await rows('project_file_embedding_g2')).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
      'Embedding rebuild waits: database busy',
    );
    state.pressure = null;
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding_g2')).toBe(total);
    // Off: nothing is filled, nothing switched.
    await configure('model-a', 16, { enabled: false });
    expect((await resolveGenerations()).filling).toBeNull();
  });
  it('stops a fill when the throttle fires mid-file, and after repeated failures', async () => {
    const target = await project('Throttle');
    // One file of more than one batch, and a few small ones.
    await projectFile(target.id, 'big.txt', ledger('Big', 90));
    for (let index = 0; index < 4; index += 1) {
      await projectFile(target.id, `small-${index}.txt`, ledger(`Small${index}`, 3));
    }
    const total = await livePassages();
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const { filling } = await resolveGenerations({ fresh: true });
    // Busy from the second check on: the first batch goes, the pause before
    // the next one finds the database busy and the run stops.
    state.pressureAfter = 1;
    const first = await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 1 });
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(total);
    state.pressureAfter = null;
    // More files, so at least four lack vectors whatever the key order filled.
    for (let index = 0; index < 4; index += 1) {
      await projectFile(target.id, `late-${index}.txt`, ledger(`Late${index}`, 3));
    }
    const pendingFiles = new Set(
      (await vectorStore().pendingPassages(filling!, { limit: 1_000 })).map(
        (passage) => passage.attachmentId,
      ),
    ).size;
    expect(pendingFiles).toBeGreaterThanOrEqual(4);
    // A provider outage: files fail, and after three in a row the run stops.
    modelB.failWith = new Error('outage');
    expect(await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 })).toBe(0);
    expect(modelB.doEmbedCalls.length).toBeGreaterThan(0);
    const failures = await pool.db
      .select()
      .from(schema.embeddingGenerationFailure)
      .where(eq(schema.embeddingGenerationFailure.generationId, 2));
    expect(failures).toHaveLength(3);
    const status = await embeddingsStatus();
    expect(status.generations.filling?.failures).toEqual({
      files: failures.length,
      lastError: 'outage',
    });
    modelB.failWith = null;
    // The job entry runs the rebuild; the backed-off files wait for their retry time.
    await embeddingRebuildJobs()[0]!.run();
    expect(await vectorStore().covers(filling!)).toBe(false);
    await pool.db.execute(
      sql`update embedding_generation_failure set retry_at = now() - interval '1 second'`,
    );
    await runEmbeddingRebuild(10_000);
    expect(await vectorStore().covers(filling!)).toBe(true);
    expect(
      await pool.db
        .select()
        .from(schema.embeddingGenerationFailure)
        .where(eq(schema.embeddingGenerationFailure.generationId, 2)),
    ).toEqual([]);
  });

  it('never fails an upload or a search when embedding into a generation goes wrong', async () => {
    const { project: target, notes } = await facilitiesProject('Failures');
    // Enabled, but no model yet: no generation, so no meaning-based search.
    await pool.db.execute(sql`
      insert into instance_setting (organization_id, key, value)
      values (${state.organizationId}, 'embeddings', '{"enabled": true}'::jsonb)
    `);
    invalidateSettingsCache();
    const scope = { userId: owner, projectId: target.id, fileIds: [notes.id] };
    expect(await semanticProjectChunks(scope, QUESTION, 10)).toBeNull();

    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    // The filling generation's provider is gone: the upload still embeds into
    // the current generation, and logs the other.
    delete state.fakes['model-b'];
    const fresh = await projectFile(target.id, 'fresh.txt', ledger('Fresh'), { index: false });
    await expect(indexUploadedProjectFile(fresh.id)).resolves.toBeUndefined();
    expect(await rows('project_file_embedding', sql`attachment_id = ${fresh.id}`)).toBeGreaterThan(
      0,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: fresh.id, generation: 2 }),
      'Embedding an uploaded project file failed',
    );
    // Bookkeeping that fails after the vectors are stored is logged, not raised.
    const store = vectorStore();
    const clear = vi.spyOn(store, 'clearFailure').mockRejectedValue(new Error('lost'));
    const again = await projectFile(target.id, 'again.txt', ledger('Again'), { index: false });
    await indexUploadedProjectFile(again.id);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: again.id }),
      'Embedding bookkeeping failed',
    );
    clear.mockRestore();
    // Reading the generations fails: the upload is still fine.
    const live = vi.spyOn(store, 'liveGenerations').mockRejectedValue(new Error('down'));
    const third = await projectFile(target.id, 'third.txt', ledger('Third'), { index: false });
    await expect(indexUploadedProjectFile(third.id)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: third.id }),
      'Embedding an uploaded project file failed',
    );
    live.mockRestore();

    // A hit whose passage left the scope after the vector search (trashed in
    // between) is dropped, not returned without its text.
    const { current } = await resolveGenerations();
    const search = vi.spyOn(store, 'search').mockResolvedValue([
      { attachmentId: notes.id, ordinal: 0, distance: 0.1 },
      { attachmentId: 'gone', ordinal: 0, distance: 0.2 },
    ]);
    const chunks = await vectorRankProjectChunks(scope, current!, fakeVector(QUESTION, 16), 5);
    expect(chunks.map((chunk) => chunk.attachmentId)).toEqual([notes.id]);
    search.mockRestore();
  });

  it('skips an automatic switch an administrator got to first, and refuses an incomplete one', async () => {
    await finishUpgrade();
    await facilitiesProject('Race');
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const { filling } = await resolveGenerations({ fresh: true });
    await expect(switchGeneration(filling!.id, { force: false, actor: null })).rejects.toThrow(
      'does not cover every passage yet',
    );
    await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 });
    const store = vectorStore();
    const switchTo = vi
      .spyOn(store, 'switchTo')
      .mockRejectedValueOnce(new GenerationStateError('Generation 2 is not being filled'));
    await runEmbeddingRebuild(10_000);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('not being filled') }),
      'Embedding generation switch skipped',
    );
    switchTo.mockRejectedValueOnce(new Error('connection lost'));
    await expect(runEmbeddingRebuild(10_000)).rejects.toThrow('connection lost');
    switchTo.mockRestore();
    await runEmbeddingRebuild(10_000);
    expect((await resolveGenerations()).current?.id).toBe(2);
    // A price change for the model being filled, or one whose storage is gone.
    await configure('model-a', 16);
    await applyModelChoice(
      {
        enabled: true,
        providerId: PROVIDER,
        modelId: 'model-a',
        dimensions: 16,
        inputPriceMicros: 5_000,
      },
      null,
    );
    expect((await resolveGenerations()).filling).toMatchObject({ id: 1, inputPriceMicros: 5_000 });
    await pool.db.execute(sql`drop table project_file_embedding`);
    await expect(switchGeneration(1, { force: true, actor: null })).rejects.toThrow(
      'is not ready yet',
    );
  });
});
