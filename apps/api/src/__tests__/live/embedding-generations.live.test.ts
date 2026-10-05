import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, DEFAULT_POST_FOLDER, eq, schema, sql } from '@oci/db';
import { embeddingCostMicros } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeEmbeddingModel,
  fakeEmbeddingModel,
  fakeVector,
} from '../../../test/fake-embeddings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Embedding generations and the vector store (v0.11 design, sections 7 and 8)
 * against real PostgreSQL with pgvector and deterministic fake embeddings
 * models: searches keep answering from generation n while n+1 fills, switch
 * atomically at coverage, n is dropped after its grace period (generation 1's
 * table only once the upgrade from v0.10 is over), new passages go to both,
 * deletes reach every generation, an interrupted fill resumes without loss or
 * duplication, and the store's person-and-project filter cannot be bypassed.
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
const { contextBudget, emptyCost } = await import('../../services/chat/context-budget.js');
const { inspectProjectFiles } = await import('../../services/chat/attachment-context.js');
const { selectProjectFiles } = await import('../../services/chat/project-context.js');
const { indexProjectFile, indexUploadedProjectFile } = await import(
  '../../services/project-search/indexing.js'
);
const { embedPendingProjectPassages, fillGeneration } = await import(
  '../../services/project-search/embedding.js'
);
const {
  applyModelChoice,
  cancelRebuild,
  resetPreviousReleaseCache,
  resolveGenerations,
  SwitchBlockedError,
  switchGeneration,
} = await import('../../services/embeddings/generations.js');
const { embeddingRebuildJobs, runEmbeddingRebuild } = await import(
  '../../services/embeddings/rebuild.js'
);
const { semanticProjectChunks, vectorRankProjectChunks } = await import(
  '../../services/project-search/semantic.js'
);
const { embeddingsStatus } = await import('../../services/embeddings/status.js');
const { vectorStore, VectorScopeError, GenerationStateError } = await import(
  '../../services/vector-store/index.js'
);

const TARGET = 'AMBER-SEVEN';
const QUESTION = 'Remind me: greenhouse heater startup password?';
const PROVIDER = 'fake-provider';

function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

function facilities(): string {
  return Array.from({ length: 10 }, (_, index) =>
    index === 6
      ? paragraph(
          `Conservatory boiler ignition passphrase is ${TARGET}; type it on the panel beside the boiler before warming begins`,
        )
      : paragraph(
          `Kitchen rota note ${index}: pantry shelves are tidied, dishes are washed and cooking area upkeep is logged by whoever is on duty`,
        ),
  ).join('\n\n');
}

function ledger(marker: string, entries = 6): string {
  return Array.from({ length: entries }, (_, index) =>
    paragraph(
      `${marker} entry ${index}: stock of zebra xylophone quokka marmalade is catalogued alphabetically in the inventory`,
    ),
  ).join('\n\n');
}

const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

describe.skipIf(!available)('live: embedding generations', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let stranger: string;
  let modelA: FakeEmbeddingModel;
  let modelB: FakeEmbeddingModel;

  async function configure(modelId: string, dimensions: number, extra: { enabled?: boolean } = {}) {
    await applyModelChoice(
      {
        enabled: extra.enabled ?? true,
        providerId: PROVIDER,
        modelId,
        dimensions,
        inputPriceMicros: null,
      },
      null,
    );
    invalidateSettingsCache();
  }

  async function project(name: string, userId = owner) {
    const [row] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId, name })
      .returning();
    return row!;
  }

  async function projectFile(
    projectId: string,
    filename: string,
    text: string,
    options: { userId?: string; index?: boolean } = {},
  ) {
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: options.userId ?? owner,
        projectId,
        filename,
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    if (options.index !== false) await indexProjectFile(row!.id);
    return row!;
  }

  async function facilitiesProject(name: string, userId = owner) {
    const target = await project(name, userId);
    const notes = await projectFile(target.id, 'facilities.txt', facilities(), { userId });
    const stock = await projectFile(target.id, 'ledger.txt', ledger('Ledger'), { userId });
    return { project: target, notes, stock };
  }

  async function select(target: { id: string; userId: string; name: string }, text = QUESTION) {
    return selectProjectFiles(
      {
        id: target.id,
        userId: target.userId,
        name: target.name,
        instructions: '',
        files: await inspectProjectFiles(target.id, target.userId),
      },
      emptyCost(),
      budget,
      false,
      text,
    );
  }

  const passageText = (selection: Awaited<ReturnType<typeof select>>) =>
    (selection.search?.passages ?? []).join('\n');

  async function expectMeaningSearch(target: { id: string; userId: string; name: string }) {
    const selection = await select(target);
    expect(selection.searchPart?.data.ranking).toBe('hybrid');
    expect(passageText(selection)).toContain(TARGET);
  }

  async function livePassages(): Promise<number> {
    const [row] = await pool.db.execute<{ total: number }>(sql`
      select count(*)::int as total from project_file_chunk c
      join attachment a on a.id = c.attachment_id
      where a.project_id is not null and a.deleted_at is null and a.upload_pending = false
    `);
    return Number(row?.total ?? 0);
  }

  async function rows(table: string, where = sql`true`) {
    const [exists] = await pool.db.execute<{ found: boolean }>(
      sql`select to_regclass(${table}) is not null as found`,
    );
    if (!exists?.found) return null;
    const [row] = await pool.db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)} where ${where}`,
    );
    return Number(row?.count ?? 0);
  }

  async function generations() {
    return pool.db.select().from(schema.embeddingGeneration).orderBy(schema.embeddingGeneration.id);
  }

  async function embedAll() {
    let total = 0;
    for (let run = 0; run < 20; run += 1) {
      const stored = await embedPendingProjectPassages();
      total += stored;
      if (stored === 0) return total;
    }
    throw new Error('The embedding job never finished');
  }

  /** Every post-deploy step recorded as finished: every replica runs this release. */
  async function finishUpgrade() {
    const journal = JSON.parse(readFileSync(join(DEFAULT_POST_FOLDER, 'journal.json'), 'utf8')) as {
      steps: Array<{ tag: string }>;
    };
    for (const step of journal.steps) {
      await pool.db.execute(sql`
        insert into oci_post_migration (name, checksum, started_at, finished_at, attempts)
        values (${step.tag}, 'test', now(), now(), 1)
        on conflict (name) do update set finished_at = now()
      `);
    }
    resetPreviousReleaseCache();
  }

  /** As during a rolling upgrade from v0.10: `migrate --post` has not run. */
  async function upgradeInProgress() {
    await pool.db.execute(sql`delete from oci_post_migration`);
    resetPreviousReleaseCache();
  }

  async function audits(action: string) {
    return pool.db
      .select({ metadata: schema.auditLog.metadata, actorUserId: schema.auditLog.actorUserId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }

  beforeAll(async () => {
    live = await createLiveDatabase('embedding_generations');
    pool = createDatabase(live.connectionString, { max: 12 });
    state.db = pool.db;
    await pool.db.execute(sql`create extension if not exists vector`);
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
  });
  beforeEach(async () => {
    const tables = await pool.db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables
          where tablename like 'project_file_embedding%' and tablename <> 'project_file_embedding_failure'`,
    );
    for (const { name } of tables) await pool.db.execute(sql`drop table ${sql.identifier(name)}`);
    await pool.db.execute(sql`delete from embedding_generation`);
    await pool.db.execute(sql`delete from project`);
    await pool.db.execute(sql`delete from audit_log`);
    await pool.db.execute(sql`delete from instance_setting where key = 'embeddings'`);
    stranger = await seedUser(pool.db, state.organizationId);
    modelA = fakeEmbeddingModel({ modelId: 'model-a', dimensions: 16 });
    modelB = fakeEmbeddingModel({ modelId: 'model-b', dimensions: 12 });
    state.fakes = { 'model-a': modelA, 'model-b': modelB };
    state.pressure = null;
    state.pressureAfter = null;
    state.pressureChecks = 0;
    invalidateSettingsCache();
    await upgradeInProgress();
    vi.mocked(logger.warn).mockClear();
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
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
