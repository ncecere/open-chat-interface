import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { PROJECT_EXCERPT_MAX_CHARS } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import { type FakeReranker, startFakeReranker } from '../../../test/fake-reranker.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Optional reranking of project search (v0.9) against real PostgreSQL and a
 * Cohere-compatible reranking server on 127.0.0.1: reordering keyword results
 * without pgvector, reranking fused results with it, fallbacks on errors and
 * timeouts, and usage charged to the person asking.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  embeddings: null as unknown,
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
  resolveEmbeddingModel: async () => state.embeddings,
}));

const available = await livePostgresAvailable();
const { logger } = await import('../../lib/logger.js');
const { encryptSecret } = await import('../../lib/crypto.js');
const { updateSetting, invalidateSettingsCache } = await import('../../services/settings.js');
const { contextBudget, emptyCost } = await import('../../services/chat/context-budget.js');
const { inspectProjectFiles } = await import('../../services/chat/attachment-context.js');
const { selectProjectFiles } = await import('../../services/chat/project-context.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { embedPendingProjectPassages } = await import('../../services/project-search/embedding.js');
const { rerankProjectCandidates } = await import('../../services/project-search/rerank.js');
const { recordRerankUsage } = await import('../../services/reranking/usage.js');

const KEY = 'sk-local-rerank-key';
const MODEL = 'bge-reranker-v2-m3';
const TARGET = 'AMBER-SEVEN';
const QUESTION = 'What is the boiler code?';

/** One paragraph of roughly a chunk's length, so each lands in its own chunk. */
function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

/**
 * Notes where one paragraph answers QUESTION but shares only "the" and
 * "boiler" with it, while every other paragraph repeats "boiler code": keyword
 * search ranks the answer below all of them.
 */
function facilities(): string {
  return Array.from({ length: 10 }, (_, index) =>
    index === 6
      ? paragraph(
          `Panel passphrase ${TARGET} starts the boiler; type it on the keypad beside the panel before warming begins`,
        )
      : paragraph(
          `Boiler code review ${index}: the boiler code style guide asks that boiler code is linted, formatted and reviewed by whoever is on duty`,
        ),
  ).join('\n\n');
}

/**
 * Thirty ledger paragraphs, so the facilities notes are a quarter of the
 * project's chunks and "boiler" and "code" are distinctive enough to search
 * by (see relevance.ts).
 */
function ledger(): string {
  return Array.from({ length: 30 }, (_, index) =>
    paragraph(
      `Ledger entry ${index}: stock of zebra xylophone quokka marmalade is catalogued alphabetically in the inventory`,
    ),
  ).join('\n\n');
}

/** An input budget of 3,200 units: the passage share (1,600) holds one passage. */
const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

describe.skipIf(!available)('live: reranking project search', () => {
  let plain: LiveDatabase;
  let vector: LiveDatabase;
  let plainPool: ReturnType<typeof createDatabase>;
  let vectorPool: ReturnType<typeof createDatabase>;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let reranker: FakeReranker;
  const providers = { plain: '', vector: '' };

  function useDatabase(target: 'plain' | 'vector') {
    pool = target === 'plain' ? plainPool : vectorPool;
    state.db = pool.db;
    invalidateSettingsCache();
  }

  async function configure(
    settings: Partial<{
      enabled: boolean;
      providerId: string | null;
      modelId: string | null;
      searchPriceMicros: number | null;
    }> = {},
  ) {
    await updateSetting('reranking', {
      enabled: true,
      providerId: pool === plainPool ? providers.plain : providers.vector,
      modelId: MODEL,
      searchPriceMicros: null,
      ...settings,
    });
  }

  async function largeProject(name: string, userId = owner) {
    const [target] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId, name })
      .returning();
    for (const [filename, text] of [
      ['facilities.txt', facilities()],
      ['ledger.txt', ledger()],
    ] as const) {
      const [file] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId,
          projectId: target!.id,
          filename,
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(text),
          storageKey: randomUUID(),
          extractedText: text,
        })
        .returning();
      await indexProjectFile(file!.id);
    }
    return target!;
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

  async function usageEvents(userId: string) {
    return pool.db
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.userId, userId))
      .orderBy(schema.usageEvent.occurredAt);
  }

  async function provider(db: typeof plainPool.db, organizationId: string) {
    const [row] = await db
      .insert(schema.provider)
      .values({
        organizationId,
        kind: 'openai-compatible',
        label: 'Local reranker',
        baseUrl: reranker.baseUrl,
        encryptedApiKey: encryptSecret(KEY),
      })
      .returning({ id: schema.provider.id });
    return row!.id;
  }

  beforeAll(async () => {
    reranker = await startFakeReranker();
    [plain, vector] = await Promise.all([
      createLiveDatabase('rerank_plain'),
      createLiveDatabase('rerank_vector'),
    ]);
    plainPool = createDatabase(plain.connectionString, { max: 8 });
    vectorPool = createDatabase(vector.connectionString, { max: 8 });
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
    providers.plain = await provider(plainPool.db, plainOrg);
    providers.vector = await provider(vectorPool.db, plainOrg);
  });
  beforeEach(() => {
    reranker.requests.length = 0;
    reranker.mode = 'ok';
    reranker.tokens = null;
    reranker.maxResults = null;
    reranker.score = (_query, document) => (document.includes(TARGET) ? 0.98 : 0.02);
    vi.mocked(logger.warn).mockClear();
  });
  afterAll(async () => {
    await reranker?.close();
    await plainPool?.sql.end({ timeout: 1 });
    await vectorPool?.sql.end({ timeout: 1 });
    await Promise.all([plain?.destroy(), vector?.destroy()]);
  });

  describe('without pgvector (keyword search)', () => {
    beforeAll(() => useDatabase('plain'));
    beforeEach(async () => {
      await pool.db.execute(sql`delete from project`);
      await pool.db.execute(sql`delete from usage_event`);
      await pool.db.execute(sql`delete from usage_record`);
      await pool.db.execute(sql`update provider set enabled = true`);
      await configure();
    });

    it('reranks keyword results so the passage that answers the question is included', async () => {
      const target = await largeProject('Keyword');

      // Off: keyword order alone, and the note says nothing about reranking.
      await configure({ enabled: false });
      const before = await select(target);
      expect(before.searchPart?.data).toMatchObject({ mode: 'search', ranking: 'keyword' });
      expect(before.searchPart?.data).not.toHaveProperty('reranked');
      expect(passageText(before)).not.toContain(TARGET);
      expect(passageText(before)).toContain('Boiler code review');
      expect(reranker.requests).toEqual([]);

      await configure();
      const after = await select(target);
      expect(after.search?.passages).toHaveLength(1);
      expect(passageText(after)).toContain(TARGET);
      expect(after.searchPart?.data).toMatchObject({
        mode: 'search',
        ranking: 'keyword',
        reranked: true,
        files: [{ name: 'facilities.txt', passages: 1 }],
      });
      // The note keeps only the start of each passage used (v0.10), not the passage.
      for (const excerpt of after.searchPart?.data.files[0]?.excerpts ?? [])
        expect(excerpt.snippet.length).toBeLessThanOrEqual(PROJECT_EXCERPT_MAX_CHARS + 1);
      expect(after.searchPart?.data.files[0]?.excerpts).toHaveLength(1);

      // One request, on the provider's /rerank, with its key and the keyword order.
      expect(reranker.requests).toHaveLength(1);
      const [request] = reranker.requests;
      expect(request!.path).toBe('/v1/rerank');
      expect(request!.authorization).toBe(`Bearer ${KEY}`);
      expect(request!.body).toMatchObject({ model: MODEL, query: QUESTION });
      const documents = request!.body.documents!;
      expect(documents.length).toBeGreaterThan(1);
      expect(documents.length).toBeLessThanOrEqual(40);
      expect(request!.body.top_n).toBe(documents.length);
      expect(documents[0]).toContain('Boiler code review');
      expect(documents.findIndex((document) => document.includes(TARGET))).toBeGreaterThan(0);
      expect(logger.warn).not.toHaveBeenCalled();

      // A message that matches nothing adds no passage, and nothing is reranked.
      const nothing = await select(target, 'zzzz qqqq');
      expect(nothing.searchPart).toBeNull();
      expect(nothing.search?.passages).toEqual([]);
      expect(reranker.requests).toHaveLength(1);
    });

    it('drops candidates the reranker scores as unrelated, leaving none if none is related', async () => {
      const target = await largeProject('Floor');
      // Only the answer is above the floor: the passages after it are dropped too.
      reranker.score = (_query, document) => (document.includes(TARGET) ? 0.6 : 0.04);
      const one = await select(target);
      expect(passageText(one)).toContain(TARGET);
      expect(one.searchPart?.data).toMatchObject({ reranked: true });

      // Nothing related: no passage, no note, though the search was reranked (and charged).
      reranker.score = () => 0.01;
      const none = await select(target);
      expect(none.search?.passages).toEqual([]);
      expect(none.search?.header).toContain('none matched the latest message closely enough');
      expect(none.searchPart).toBeNull();
      expect(await usageEvents(owner)).toHaveLength(2);

      // Scores off the 0–1 scale (raw logits) are used to order, never as a floor.
      reranker.score = (_query, document) => (document.includes(TARGET) ? 4.2 : -3.1);
      const scope = { userId: owner, projectId: target.id };
      const chunk = (index: number, content: string) => ({
        attachmentId: 'file',
        filename: 'file.txt',
        ordinal: index,
        start: 0,
        end: 10,
        content,
      });
      const candidates = [chunk(0, 'boiler code'), chunk(1, TARGET), chunk(2, 'boiler')];
      const logits = await rerankProjectCandidates(scope, QUESTION, candidates);
      expect(logits.candidates.map((candidate) => candidate.ordinal)).toEqual([1, 0, 2]);
      expect(logits.reranked).toBe(true);
    });

    it('charges each reranked message to the person asking, at the configured price', async () => {
      const target = await largeProject('Charged');
      const other = await seedUser(pool.db, state.organizationId);
      const theirs = await largeProject('Theirs', other);

      // No price, no reported tokens: still one event, at no cost.
      await select(target);
      let events = await usageEvents(owner);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        modelSlug: `rerank:${MODEL}`,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: 0,
        pending: false,
        usageUnknown: false,
      });

      // $2 per 1,000 searches is 2,000 micro-dollars a search; tokens are recorded when reported.
      await configure({ searchPriceMicros: 2_000_000 });
      reranker.tokens = 120;
      await select(target);
      events = await usageEvents(owner);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        modelSlug: `rerank:${MODEL}`,
        messageCount: 0,
        tokensIn: 120,
        costMicros: 2_000,
      });
      const [rollup] = await pool.db
        .select()
        .from(schema.usageRecord)
        .where(eq(schema.usageRecord.userId, owner));
      expect(rollup).toMatchObject({
        modelSlug: `rerank:${MODEL}`,
        messageCount: 0,
        tokensIn: 120,
        costMicros: 2_000,
      });
      expect(await usageEvents(other)).toEqual([]);

      // Someone else asking in their own project is charged to them.
      await select(theirs);
      expect(await usageEvents(other)).toHaveLength(1);
      expect(await usageEvents(owner)).toHaveLength(2);

      // Nothing is recorded for a person who no longer exists.
      const gone = randomUUID();
      await recordRerankUsage({
        organizationId: state.organizationId,
        userId: gone,
        modelId: MODEL,
        tokens: 5,
        searchPriceMicros: 2_000_000,
      });
      expect(await usageEvents(gone)).toEqual([]);
    });

    it('keeps the previous order when the reranker fails, and charges nothing', async () => {
      const target = await largeProject('Failing');
      reranker.mode = 'error';
      const selection = await select(target);
      expect(selection.searchPart?.data).toMatchObject({
        mode: 'search',
        ranking: 'keyword',
        reranked: false,
      });
      expect(passageText(selection)).not.toContain(TARGET);
      expect(passageText(selection)).toContain('Boiler code review');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: target.id }),
        'Reranking project passages failed; using the previous order',
      );
      const [[logged]] = vi.mocked(logger.warn).mock.calls as unknown as [[{ error: Error }]];
      expect(logged.error.message).toBe(
        'Local reranker returned an error while reranking (HTTP 500).',
      );
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(KEY);
      expect(await usageEvents(owner)).toEqual([]);
    });

    it('keeps the previous order when the reranker does not answer within 5 seconds', async () => {
      const target = await largeProject('Slow');
      reranker.mode = 'hang';
      const started = Date.now();
      const selection = await select(target);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(9_000);
      expect(selection.searchPart?.data).toMatchObject({ reranked: false });
      expect(passageText(selection)).not.toContain(TARGET);
      const [[logged]] = vi.mocked(logger.warn).mock.calls as unknown as [[{ error: Error }]];
      expect(logged.error.message).toBe('Local reranker did not rerank within 5 s.');
      expect(await usageEvents(owner)).toEqual([]);
    }, 20_000);

    it('keeps the previous order when the provider cannot be used', async () => {
      const target = await largeProject('Disabled');
      await pool.db.execute(sql`update provider set enabled = false`);
      const selection = await select(target);
      expect(selection.searchPart?.data).toMatchObject({ reranked: false });
      expect(reranker.requests).toEqual([]);
      const [[logged]] = vi.mocked(logger.warn).mock.calls as unknown as [[{ error: Error }]];
      expect(logged.error.message).toBe('Local reranker is disabled');

      // Switched on without a model, reranking is simply off.
      await configure({ modelId: null });
      const off = await select(target);
      expect(off.searchPart?.data).not.toHaveProperty('reranked');
    });

    it('reranks only the best 40 candidates and keeps the rest after them', async () => {
      const chunk = (index: number) => ({
        attachmentId: 'file',
        filename: 'file.txt',
        ordinal: index,
        start: 0,
        end: 10,
        content: `candidate ${index}`,
      });
      const candidates = Array.from({ length: 45 }, (_, index) => chunk(index));
      const scope = { userId: owner, projectId: randomUUID() };
      // The model prefers later candidates and scores only ten of them.
      reranker.score = (_query, document) => Number(document.split(' ')[1]);
      reranker.maxResults = 10;
      const result = await rerankProjectCandidates(scope, QUESTION, candidates);
      expect(result.reranked).toBe(true);
      expect(reranker.requests[0]!.body.documents).toEqual(
        candidates.slice(0, 40).map((candidate) => candidate.content),
      );
      expect(result.candidates.map((candidate) => candidate.ordinal)).toEqual([
        ...[39, 38, 37, 36, 35, 34, 33, 32, 31, 30],
        ...Array.from({ length: 30 }, (_, index) => index),
        ...[40, 41, 42, 43, 44],
      ]);

      // A model that scores nothing has not reranked anything.
      reranker.maxResults = 0;
      expect(await rerankProjectCandidates(scope, QUESTION, candidates)).toEqual({
        candidates,
        reranked: false,
      });
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({
          error: new Error('Local reranker returned no reranking results'),
        }),
        'Reranking project passages failed; using the previous order',
      );

      // Nothing to reorder, or nothing to ask: no request, and not reranked.
      reranker.requests.length = 0;
      expect(await rerankProjectCandidates(scope, QUESTION, [chunk(0)])).toEqual({
        candidates: [chunk(0)],
        reranked: false,
      });
      expect(await rerankProjectCandidates(scope, ' \u0007 ', candidates)).toEqual({
        candidates,
        reranked: false,
      });
      expect(reranker.requests).toEqual([]);
      await configure({ enabled: false });
      expect(await rerankProjectCandidates(scope, QUESTION, candidates)).toEqual({
        candidates,
        reranked: undefined,
      });
    });
  });

  describe('with pgvector (meaning-based search)', () => {
    beforeAll(async () => {
      useDatabase('vector');
      state.embeddings = fakeEmbeddingModel();
      await updateSetting('embeddings', {
        enabled: true,
        providerId: 'fake-provider',
        modelId: 'fake-embed',
        dimensions: 16,
        inputPriceMicros: null,
      });
      await configure();
    });

    it('reranks the fused results and packs passages in the reranked order', async () => {
      const target = await largeProject('Hybrid');
      while ((await embedPendingProjectPassages()) > 0) {
        // Embeds every passage.
      }
      // Fused order first, then the reranker's choice: a passage from the ledger.
      reranker.score = (_query, document) => (document.includes('Ledger entry 3') ? 0.9 : 0.1);
      const selection = await select(target, 'boiler code ledger');
      expect(selection.searchPart?.data).toMatchObject({
        mode: 'search',
        ranking: 'hybrid',
        reranked: true,
        files: [{ name: 'ledger.txt', passages: 1 }],
      });
      expect(passageText(selection)).toContain('Ledger entry 3');
      expect(reranker.requests).toHaveLength(1);
      expect(reranker.requests[0]!.body.documents!.length).toBeLessThanOrEqual(40);
      expect(await usageEvents(owner)).toEqual(
        expect.arrayContaining([expect.objectContaining({ modelSlug: `rerank:${MODEL}` })]),
      );
    });
  });
});
