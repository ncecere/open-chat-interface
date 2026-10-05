import { eq, schema, sql } from '@oci/db';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EmbeddingGenerationsContext,
  PROVIDER,
  QUESTION,
  TARGET,
  useEmbeddingGenerationsSuite,
} from '../../../test/embedding-generations.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Embedding generations and the vector store (v0.11 design, sections 7 and 8)
 * against real PostgreSQL with pgvector and deterministic fake embeddings
 * models: searches keep answering from generation n while n+1 fills, switch
 * atomically at coverage, and n is dropped after its grace period (generation
 * 1's table only once the upgrade from v0.10 is over).
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
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { embedPendingProjectPassages, fillGeneration } = await import(
  '../../services/project-search/embedding.js'
);
const { resolveGenerations, SwitchBlockedError, switchGeneration } = await import(
  '../../services/embeddings/generations.js'
);
const { runEmbeddingRebuild } = await import('../../services/embeddings/rebuild.js');
const { embeddingsStatus } = await import('../../services/embeddings/status.js');
const { vectorStore } = await import('../../services/vector-store/index.js');

describe.skipIf(!available)('live: embedding generations', () => {
  const suite = useEmbeddingGenerationsSuite(state);
  const {
    configure,
    facilitiesProject,
    select,
    passageText,
    expectMeaningSearch,
    livePassages,
    rows,
    generations,
    embedAll,
    finishUpgrade,
    upgradeInProgress,
    audits,
  } = suite;
  let pool: EmbeddingGenerationsContext['pool'];
  let modelA: EmbeddingGenerationsContext['modelA'];
  let modelB: EmbeddingGenerationsContext['modelB'];
  beforeAll(() => {
    ({ pool } = suite.ctx);
  });
  beforeEach(() => {
    ({ modelA, modelB } = suite.ctx);
  });

  it('keeps answering from generation n throughout a rebuild, switches at coverage, and drops n after its grace period', async () => {
    await finishUpgrade();
    const { project: target } = await facilitiesProject('Facilities');
    const total = await livePassages();
    await configure('model-a', 16);
    expect(await embedAll()).toBe(total);
    await expectMeaningSearch(target);

    // A model of other dimensions: generation 2 fills while 1 answers.
    await configure('model-b', 12);
    const { current, filling } = await resolveGenerations({ fresh: true });
    expect(current).toMatchObject({ id: 1, tableName: 'project_file_embedding' });
    expect(filling).toMatchObject({
      id: 2,
      tableName: 'project_file_embedding_g2',
      dimensions: 12,
    });
    let embedded = 0;
    while (embedded < total) {
      // Questions are still embedded with generation 1's model.
      modelA.embedded.length = 0;
      modelB.embedded.length = 0;
      await expectMeaningSearch(target);
      expect(modelA.embedded).toEqual([QUESTION]);
      expect(modelB.embedded).toEqual([]);
      const status = await embeddingsStatus();
      expect(status.generations.current).toMatchObject({ id: 1, passages: { embedded: total } });
      expect(status.generations.filling).toMatchObject({ id: 2, passages: { total, embedded } });
      // Nothing is switched before the job sees it complete.
      embedded += await fillGeneration(filling!, {
        deadline: Date.now() + 60_000,
        pauseMs: 0,
        limit: 4,
      });
    }
    expect(await rows('project_file_embedding_g2')).toBe(total);
    expect((await resolveGenerations()).current?.id).toBe(1);

    // The job finds it complete and switches.
    await runEmbeddingRebuild(10_000);
    const after = await resolveGenerations({ fresh: true });
    expect(after).toMatchObject({ current: { id: 2, state: 'current' }, filling: null });
    modelA.embedded.length = 0;
    modelB.embedded.length = 0;
    await expectMeaningSearch(target);
    expect(modelB.embedded).toEqual([QUESTION]);
    expect(modelA.embedded).toEqual([]);
    expect((await audits('embeddings.generation.switch')).map((row) => row.metadata)).toEqual([
      {
        generation: 2,
        providerId: PROVIDER,
        modelId: 'model-b',
        dimensions: 12,
        previous: 1,
        passages: { total, embedded: total },
        forced: false,
        automatic: true,
      },
    ]);
    // The setting (what v0.10 would read) follows the switch.
    const [setting] = await pool.db
      .select({ value: schema.instanceSetting.value })
      .from(schema.instanceSetting)
      .where(eq(schema.instanceSetting.key, 'embeddings'));
    expect(setting?.value).toMatchObject({ enabled: true, modelId: 'model-b', dimensions: 12 });

    // Generation 1 is kept through its grace period, then dropped by the job.
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding')).toBe(total);
    await pool.db.execute(
      sql`update embedding_generation set drop_after = now() - interval '1 second' where id = 1`,
    );
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding')).toBeNull();
    expect((await generations()).map((row) => [row.id, row.state])).toEqual([
      [1, 'dropped'],
      [2, 'current'],
    ]);
    expect((await audits('embeddings.generation.drop')).map((row) => row.metadata)).toEqual([
      { generation: 1, table: 'project_file_embedding', modelId: 'model-a', state: 'retired' },
    ]);
    await expectMeaningSearch(target);
  });

  it('switches atomically: searches running through the switch all find passages by meaning', async () => {
    await finishUpgrade();
    const { project: target } = await facilitiesProject('Atomic');
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    const { filling } = await resolveGenerations({ fresh: true });
    await fillGeneration(filling!, { deadline: Date.now() + 60_000, pauseMs: 0 });

    // Three readers search without pause from before the switch until three
    // searches each after it.
    const results: Awaited<ReturnType<typeof select>>[] = [];
    let switchedYet = false;
    const reader = async () => {
      let after = 0;
      while (!switchedYet || after < 3) {
        results.push(await select(target));
        if (switchedYet) after += 1;
      }
    };
    const readers = [reader(), reader(), reader()];
    await vi.waitFor(() => expect(results.length).toBeGreaterThan(2));
    const switched = await switchGeneration(filling!.id, { force: false, actor: null });
    switchedYet = true;
    await Promise.all(readers);
    expect(switched).toMatchObject({ current: { id: 2 }, retired: { id: 1 }, forced: false });
    for (const result of results) {
      expect(result.searchPart?.data.ranking).toBe('hybrid');
      expect(passageText(result)).toContain(TARGET);
    }
    // Both models answered some of them: the switch happened mid-way.
    expect(modelA.embedded.filter((value) => value === QUESTION).length).toBeGreaterThan(0);
    expect(modelB.embedded.filter((value) => value === QUESTION).length).toBeGreaterThan(0);
    expect((await generations()).filter((row) => row.state === 'current')).toHaveLength(1);
  });

  it('waits for the upgrade to finish before leaving or dropping generation 1, the table v0.10 uses', async () => {
    const { project: target } = await facilitiesProject('Upgrade');
    const total = await livePassages();
    await configure('model-a', 16);
    await embedAll();
    await configure('model-b', 12);
    await runEmbeddingRebuild(10_000);
    // Complete, but v0.10 replicas may still read generation 1's table.
    expect(await rows('project_file_embedding_g2')).toBe(total);
    let status = await embeddingsStatus();
    expect(status.generations).toMatchObject({
      current: { id: 1 },
      filling: { id: 2, passages: { total, embedded: total }, etaSeconds: 0 },
      switchBlocked: 'upgrade-in-progress',
    });
    await expect(switchGeneration(2, { force: true, actor: null })).rejects.toBeInstanceOf(
      SwitchBlockedError,
    );
    await expectMeaningSearch(target);

    await finishUpgrade();
    await runEmbeddingRebuild(10_000);
    status = await embeddingsStatus();
    expect(status.generations).toMatchObject({
      current: { id: 2 },
      filling: null,
      retired: [{ id: 1 }],
      switchBlocked: null,
    });

    // Due for dropping, but while replicas of the previous release may run
    // (here: the post-deploy record gone again), generation 1's table stays.
    await pool.db.execute(
      sql`update embedding_generation set drop_after = now() - interval '1 second' where id = 1`,
    );
    await upgradeInProgress();
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding')).toBe(total);
    const [first] = await generations();
    expect(
      await vectorStore().dropStorage(
        { ...first!, inputPriceMicros: null, state: 'retired' } as never,
        { previousReleaseGone: false },
      ),
    ).toBe(false);
    await finishUpgrade();
    await runEmbeddingRebuild(10_000);
    expect(await rows('project_file_embedding')).toBeNull();
  });

  it('does not fight a v0.10 replica that re-created generation 1 for another model mid-upgrade', async () => {
    const { project: target } = await facilitiesProject('Old replica');
    await configure('model-a', 16);
    await embedAll();
    await expectMeaningSearch(target);
    // What v0.10's admin page and job do: save another model in the setting,
    // then drop and re-create the table at its size.
    await pool.db.execute(sql`
      update instance_setting
      set value = value || '{"modelId": "model-b", "dimensions": 12}'::jsonb
      where key = 'embeddings'
    `);
    await pool.db.execute(sql`drop table project_file_embedding`);
    await pool.db.execute(sql`
      create table project_file_embedding (
        attachment_id text not null, ordinal integer not null, model_key text not null,
        embedding vector(12) not null, embedded_at timestamp with time zone not null default now(),
        constraint project_file_embedding_pk primary key (attachment_id, ordinal))
    `);
    invalidateSettingsCache();
    // v0.11 neither re-creates it nor writes into it, and says why search is keyword-only.
    expect(await embedPendingProjectPassages()).toBe(0);
    expect(await vectorStore().storageState((await resolveGenerations()).current!)).toBe(
      'mismatch',
    );
    expect((await select(target)).searchPart).toBeNull();
    const { embeddingsHealthCheck } = await import('../../services/embeddings/status.js');
    expect(await embeddingsHealthCheck()).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('Was the model changed on a replica of the previous release'),
    });
    expect(await rows('project_file_embedding')).toBe(0);
  });
});
