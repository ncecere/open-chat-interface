import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeEmbeddingModel,
  fakeEmbeddingModel,
  words,
} from '../../../test/fake-embeddings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Meaning-based search for project files (v0.9) against real PostgreSQL with
 * pgvector: keyword-only behaviour while the extension is absent, the runtime
 * embedding table, the background job, hybrid ranking with a deterministic
 * fake embeddings model, fallbacks, usage attribution and isolation.
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
const { updateSetting, invalidateSettingsCache } = await import('../../services/settings.js');
const { contextBudget, emptyCost } = await import('../../services/chat/context-budget.js');
const { inspectProjectFiles } = await import('../../services/chat/attachment-context.js');
const { selectProjectFiles } = await import('../../services/chat/project-context.js');
const { indexProjectFile, indexUploadedProjectFile } = await import(
  '../../services/project-search/indexing.js'
);
const { embedPendingProjectPassages, EMBED_BATCH } = await import(
  '../../services/project-search/embedding.js'
);
const { semanticProjectChunks, vectorRankProjectChunks } = await import(
  '../../services/project-search/semantic.js'
);
const { embeddingStorage, ensureEmbeddingTable, pgvectorInfo } = await import(
  '../../services/embeddings/storage.js'
);
const { resolveEmbeddingModel } = await import('../../services/embeddings/model.js');
const { embeddingsStatus, embeddingsHealthCheck } = await import(
  '../../services/embeddings/status.js'
);
const { encryptSecret } = await import('../../lib/crypto.js');

const TARGET = 'AMBER-SEVEN';
const QUESTION = 'Remind me: greenhouse heater startup password?';

/** One paragraph of roughly a chunk's length, so each lands in its own chunk. */
function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

/**
 * Facilities notes where exactly one paragraph says how to start the
 * conservatory boiler. It shares no word with QUESTION, so keyword search
 * cannot find it; it shares meaning, so the fake embeddings model does.
 */
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

function ledger(marker = 'Ledger'): string {
  return Array.from({ length: 6 }, (_, index) =>
    paragraph(
      `${marker} entry ${index}: stock of zebra xylophone quokka marmalade is catalogued alphabetically in the inventory`,
    ),
  ).join('\n\n');
}

/** An input budget of 3,200 units: the passage share (1,600) holds one passage. */
const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

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

  async function configure(
    settings: Partial<{
      enabled: boolean;
      providerId: string;
      modelId: string;
      dimensions: number | null;
      inputPriceMicros: number | null;
    }>,
  ) {
    await updateSetting('embeddings', {
      enabled: true,
      providerId: 'fake-provider',
      modelId: 'fake-embed',
      dimensions: 16,
      inputPriceMicros: null,
      ...settings,
    });
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

  async function largeProject(name: string, userId = owner) {
    const target = await project(name, userId);
    const notes = await projectFile(target.id, 'facilities.txt', facilities(), { userId });
    const stock = await projectFile(target.id, 'ledger.txt', ledger(), { userId });
    return { project: target, notes, stock };
  }

  async function select(target: { id: string; userId: string; name: string }, text: string) {
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

  async function usageEvents(userId: string) {
    return pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.userId, userId))
      .orderBy(schema.usageEvent.occurredAt);
  }

  async function chunkContents(attachmentId: string): Promise<string[]> {
    const rows = await pool.db
      .select({ content: schema.projectFileChunk.content })
      .from(schema.projectFileChunk)
      .where(eq(schema.projectFileChunk.attachmentId, attachmentId))
      .orderBy(schema.projectFileChunk.ordinal);
    return rows.map((row) => row.content);
  }

  async function embeddingRows() {
    return pool.db.execute<{ attachment_id: string; ordinal: number; model_key: string }>(
      sql`select attachment_id, ordinal, model_key from project_file_embedding order by attachment_id, ordinal`,
    );
  }

  /** Runs the job until nothing is left. */
  async function embedAll() {
    let total = 0;
    for (let run = 0; run < 20; run += 1) {
      const stored = await embedPendingProjectPassages();
      total += stored;
      if (stored === 0) return total;
    }
    throw new Error('The embedding job never finished');
  }

  beforeAll(async () => {
    [plain, vector] = await Promise.all([
      createLiveDatabase('hybrid_plain'),
      createLiveDatabase('hybrid_vector'),
    ]);
    plainPool = createDatabase(plain.connectionString, { max: 8 });
    vectorPool = createDatabase(vector.connectionString, { max: 8 });
    // The operator's step; OCI itself never creates the extension.
    await vectorPool.db.execute(sql`create extension vector`);
    const [plainOrg, vectorOrg] = await Promise.all([
      seedOrganization(plainPool.db),
      seedOrganization(vectorPool.db),
    ]);
    // Both databases get the same organization and owner ids, so the mocks fit either.
    await vectorPool.db.execute(
      sql`update organization set id = ${plainOrg} where id = ${vectorOrg}`,
    );
    state.organizationId = plainOrg;
    owner = await seedUser(plainPool.db, plainOrg);
    await vectorPool.db.execute(
      sql`insert into "user" (id, name, email, email_verified, role, organization_id)
          values (${owner}, 'Owner', ${`${owner}@example.com`}, true, 'user', ${plainOrg})`,
    );
  });
  beforeEach(() => {
    fake = fakeEmbeddingModel();
    state.fake = fake;
    vi.mocked(logger.warn).mockClear();
  });
  afterAll(async () => {
    await plainPool?.sql.end({ timeout: 1 });
    await vectorPool?.sql.end({ timeout: 1 });
    await Promise.all([plain?.destroy(), vector?.destroy()]);
  });

  describe('without pgvector', () => {
    beforeAll(() => useDatabase('plain'));

    it('stays keyword-only, exactly as before, even with an embeddings model configured', async () => {
      expect(await pgvectorInfo()).toEqual({ state: 'available', version: null, schema: null });
      expect(await embeddingStorage()).toBeNull();
      const { project: target } = await largeProject('Plain');

      await configure({ enabled: false });
      const before = await select(target, QUESTION);
      const keyword = await select(target, 'kitchen rota pantry');
      await configure({ enabled: true });
      const after = await select(target, QUESTION);
      const keywordAfter = await select(target, 'kitchen rota pantry');

      // The paraphrase finds nothing by keyword: the opening passages are used.
      expect(after.search).toEqual(before.search);
      expect(after.searchPart?.data).toEqual(before.searchPart?.data);
      expect(after.searchPart?.data.mode).toBe('opening');
      expect(passageText(after)).not.toContain(TARGET);
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
      await expect(ensureEmbeddingTable(16)).rejects.toThrow('pgvector extension is not enabled');
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
      await configure({});
    });

    it('creates the embedding table once, safely under concurrency, and re-creates it for new dimensions', async () => {
      await pool.db.execute(sql`drop table if exists project_file_embedding`);
      const results = await Promise.all(Array.from({ length: 6 }, () => ensureEmbeddingTable(16)));
      expect(results.filter((result) => result === 'created')).toHaveLength(1);
      expect(results.filter((result) => result === 'ready')).toHaveLength(5);
      expect(await embeddingStorage()).toEqual({ schema: 'public', dimensions: 16 });
      expect(await ensureEmbeddingTable(16)).toBe('ready');
      const changed = await Promise.all([ensureEmbeddingTable(8), ensureEmbeddingTable(8)]);
      expect(changed.sort()).toEqual(['ready', 'recreated']);
      expect((await embeddingStorage())?.dimensions).toBe(8);
      expect(await ensureEmbeddingTable(16)).toBe('recreated');
      await expect(ensureEmbeddingTable(0)).rejects.toThrow(RangeError);
      await expect(ensureEmbeddingTable(16001)).rejects.toThrow(RangeError);
      await expect(ensureEmbeddingTable(1.5)).rejects.toThrow(RangeError);
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

    it('finds a paraphrased passage that keyword search misses', async () => {
      const { project: target } = await largeProject('Hybrid');
      await embedAll();

      const hybrid = await select(target, QUESTION);
      expect(passageText(hybrid)).toContain(TARGET);
      expect(hybrid.search?.header).toContain('best match the latest message');
      expect(hybrid.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'hybrid' });
      expect(hybrid.searchPart?.data.files[0]?.name).toBe('facilities.txt');
      expect(JSON.stringify(hybrid.searchPart)).not.toContain(TARGET);

      // Exact words still win: the keyword match is ranked first.
      const exact = await select(target, 'zebra xylophone quokka marmalade');
      expect(exact.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'hybrid' });
      expect(passageText(exact)).toContain('Ledger entry');

      // Switched off, the same question falls back to keyword search alone.
      await configure({ enabled: false });
      const keyword = await select(target, QUESTION);
      expect(keyword.searchPart?.data.mode).toBe('opening');
      expect(passageText(keyword)).not.toContain(TARGET);
      // A message with nothing to search for is never embedded.
      await configure({});
      fake.embedded.length = 0;
      await select(target, '?! … —');
      expect(fake.embedded).toEqual([]);
    });

    it('falls back to keyword search when the embeddings call fails, and backs failing files off', async () => {
      const { project: target, notes } = await largeProject('Failing');
      await embedAll();
      fake.failWith = new Error('provider down');

      const selection = await select(target, QUESTION);
      expect(selection.searchPart?.data.mode).toBe('opening');
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
        .from(schema.projectFileEmbeddingFailure)
        .where(eq(schema.projectFileEmbeddingFailure.attachmentId, extra.id));
      expect(failure).toMatchObject({
        modelKey: 'fake-provider/fake-embed/16',
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
        sql`update project_file_embedding_failure set retry_at = now() - interval '1 second'`,
      );
      fake.failWith = new Error('still down');
      await embedPendingProjectPassages();
      const [second] = await pool.db.select().from(schema.projectFileEmbeddingFailure);
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
        sql`update project_file_embedding_failure set retry_at = now() - interval '1 second'`,
      );
      expect(await embedAll()).toBeGreaterThan(0);
      expect(await pool.db.select().from(schema.projectFileEmbeddingFailure)).toEqual([]);
      expect((await embeddingRows()).some((row) => row.attachment_id === notes.id)).toBe(true);
    });

    it('stops a run after repeated failures, so a provider outage is not hammered', async () => {
      const many = await project('Many');
      for (let index = 0; index < 5; index += 1) {
        await projectFile(many.id, `file-${index}.txt`, ledger(`File${index}`));
      }
      fake.failWith = new Error('outage');
      expect(await embedPendingProjectPassages()).toBe(0);
      expect(fake.doEmbedCalls).toHaveLength(3);
      expect(await pool.db.select().from(schema.projectFileEmbeddingFailure)).toHaveLength(3);
    });

    it('embeds an uploaded file straight away when storage is ready', async () => {
      const target = await project('Uploads');
      await ensureEmbeddingTable(16);
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

    it('re-embeds everything when the model changes, and uses keyword search meanwhile', async () => {
      const { project: target, notes, stock } = await largeProject('Changing');
      const total = (await chunkContents(notes.id)).length + (await chunkContents(stock.id)).length;
      await embedAll();
      expect((await select(target, QUESTION)).searchPart?.data.ranking).toBe('hybrid');

      // Same dimensions, new model: old vectors are ignored until replaced in place.
      await configure({ modelId: 'fake-embed-2' });
      const meanwhile = await select(target, QUESTION);
      expect(meanwhile.searchPart?.data.mode).toBe('opening');
      expect(await embedAll()).toBe(total);
      const rows = await embeddingRows();
      expect(rows).toHaveLength(total);
      expect(new Set(rows.map((row) => row.model_key))).toEqual(
        new Set(['fake-provider/fake-embed-2/16']),
      );
      expect((await select(target, QUESTION)).searchPart?.data.ranking).toBe('hybrid');

      // New dimensions: the table is re-created at the new size and filled again.
      fake = fakeEmbeddingModel({ modelId: 'fake-embed-3', dimensions: 12 });
      state.fake = fake;
      await configure({ modelId: 'fake-embed-3', dimensions: 12 });
      expect((await select(target, QUESTION)).searchPart?.data.mode).toBe('opening');
      expect(await embedAll()).toBe(total);
      expect((await embeddingStorage())?.dimensions).toBe(12);
      const status = await embeddingsStatus();
      expect(status).toMatchObject({
        active: true,
        storageDimensions: 12,
        pgvector: { state: 'enabled', version: expect.any(String) },
        passages: { embedded: total },
      });
      expect(await embeddingsHealthCheck()).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining(`${total} of ${total} passages embedded with fake-embed-3`),
      });
      const hybrid = await select(target, QUESTION);
      expect(passageText(hybrid)).toContain(TARGET);

      // A model returning the wrong size is refused, never stored.
      fake = fakeEmbeddingModel({ modelId: 'fake-embed-3', dimensions: 5 });
      state.fake = fake;
      expect((await select(target, QUESTION)).searchPart?.data.mode).toBe('opening');
      await ensureEmbeddingTable(12);
      await configure({ modelId: 'fake-embed-3', dimensions: 16 });
      // Storage is the wrong size for the setting until the job re-creates it.
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
      const key = 'fake-provider/fake-embed/16';
      const nearest = await vectorRankProjectChunks(
        scope,
        { schema: 'public' },
        key,
        (await fake.doEmbed({ values: [QUESTION] })).embeddings[0]!,
        50,
      );
      expect(nearest.length).toBeGreaterThan(0);
      expect(new Set(nearest.map((chunk) => chunk.attachmentId))).toEqual(new Set([mine.notes.id]));
      expect(nearest[0]!.content).toContain(TARGET);
      expect(
        await vectorRankProjectChunks({ ...scope, fileIds: [] }, { schema: 'public' }, key, [1], 5),
      ).toEqual([]);
      expect(await semanticProjectChunks({ ...scope, fileIds: [] }, QUESTION, 5)).toBeNull();
      expect(await semanticProjectChunks(scope, '   ', 5)).toBeNull();
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
