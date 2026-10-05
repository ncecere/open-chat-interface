import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KESTREL,
  modelText,
  projectSearchHelpers,
  smallModelFor,
} from '../../../test/chat-project-search.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Large project files in the model context: when a project's files do not
 * all fit, the latest message searches their chunks and only the best
 * passages reach the model. Admission, budgeting, retrieval, persistence and
 * SDK conversion are real; setupTurn stops before any provider is called, and
 * the assembled model input is what these tests inspect.
 *
 * This file: hostile messages, other people's and projects' files, files left out.
 * The shared fixtures and helpers are in test/chat-project-search.fixtures.ts;
 * the other chat-project-search-*.live.test.ts file covers the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  system: 'INSTANCE PROMPT',
  contextWindow: undefined as number | undefined,
  maxOutputTokens: undefined as number | undefined,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: state.contextWindow,
    maxOutputTokens: state.maxOutputTokens,
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: true, temporaryChat: true };
    if (key === 'storage') return { maxFilesPerMessage: 10 };
    if (key === 'roleFeatures') return {};
    // Chat-wide settings (such as the tool step limit) keep their defaults.
    if (key === 'chat') return {};
    // Meaning-based search is off: keyword search only, as in v0.8.
    if (key === 'embeddings') return {};
    // Reranking is off: the note carries no `reranked` field.
    if (key === 'reranking') return {};
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => state.system,
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/quota/index.js', () => ({
  reserveQuotaForRun: async () => null,
  releaseReservation: async () => {},
  settleReservation: async () => {},
  recordUsage: async () => {},
}));
vi.mock('../../services/chat-streams.js', () => ({
  beginChatRun: async () => 'unavailable',
  abandonChatRun: async () => {},
  unregisterLocalChatRun: () => {},
}));

const available = await livePostgresAvailable();
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { indexedChunkCounts, rankProjectChunks, projectSearchTerms } = await import(
  '../../services/project-search/retrieval.js'
);
const smallModel = smallModelFor(state);

describe.skipIf(!available)('live: searching large project files', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let driver: LocalStorageDriver;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('project_search');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-project-search-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
  });
  beforeEach(() => {
    state.contextWindow = undefined;
    state.maxOutputTokens = undefined;
  });
  afterEach(async () => {
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const { project, projectFile, thread, send, largeProject } = projectSearchHelpers({
    get pool() {
      return pool;
    },
    get owner() {
      return owner;
    },
    get organizationId() {
      return state.organizationId;
    },
    get driver() {
      return driver;
    },
    runs,
    indexProjectFile,
  });

  it('never interprets operators or SQL in the message', async () => {
    smallModel();
    const { operations } = await largeProject('Hostile');
    const hostile = [
      "')::tsquery; drop table project_file_chunk; -- Kestrel",
      "kestrel:* & !'' | <-> (( \\' \u0001",
      `${'!&|<->():*'.repeat(100)} kestrel`,
    ];
    for (const message of hostile) {
      const started = await send((await thread(operations.id)).id, message);
      expect(await modelText(started)).toContain(KESTREL);
    }
    expect(await projectSearchTerms("a ' & | ! <-> :*")).toEqual([]);
    expect(await projectSearchTerms(' \u0001\u0002 ')).toEqual([]);
    expect(await projectSearchTerms("O'Brien's kestrel-nest of")).toEqual(
      expect.arrayContaining([
        { operand: "'brien':*", stopWord: false },
        { operand: "'kestrel-nest':*", stopWord: false },
        { operand: "'kestrel':*", stopWord: false },
        { operand: "'nest':*", stopWord: false },
        { operand: "'of'", stopWord: true },
      ]),
    );
    const [rows] = await pool.db.execute<{ total: number }>(
      sql`select count(*)::int as total from project_file_chunk`,
    );
    expect(rows?.total).toBeGreaterThan(0);
  });

  it('never uses another person’s or another project’s chunks', async () => {
    smallModel();
    const { operations, handbookFile } = await largeProject('Mine');
    const otherProject = await project('Other project');
    const sibling = await projectFile(
      otherProject.id,
      'other.txt',
      'OTHER_PROJECT_MARKER Operation Kestrel launch code launch code Kestrel.',
    );
    const stranger = await seedUser(pool.db, state.organizationId);
    const theirs = await project('Theirs', stranger);
    const foreign = await projectFile(
      theirs.id,
      'theirs.txt',
      'STRANGER_MARKER Operation Kestrel launch code launch code Kestrel.',
      { userId: stranger },
    );

    const started = await send(
      (await thread(operations.id)).id,
      'What is the launch code for Operation Kestrel?',
    );
    const text = await modelText(started);
    expect(text).toContain(KESTREL);
    expect(text).not.toContain('OTHER_PROJECT_MARKER');
    expect(text).not.toContain('STRANGER_MARKER');

    // The retrieval query re-checks owner and project even for ids it is handed.
    const operands = await projectSearchTerms('kestrel launch');
    const mine = { userId: owner, projectId: operations.id, fileIds: [handbookFile.id] };
    expect(await rankProjectChunks(mine, [], 10)).toEqual([]);
    expect(await rankProjectChunks({ ...mine, fileIds: [] }, operands, 10)).toEqual([]);
    expect(await rankProjectChunks(mine, operands, 0)).toEqual([]);
    expect(await indexedChunkCounts([])).toEqual(new Map());
    expect(
      await rankProjectChunks({ ...mine, fileIds: [foreign.id, sibling.id] }, operands, 10),
    ).toEqual([]);
    for (const fileId of [sibling.id, foreign.id]) {
      const chunks = await rankProjectChunks(
        { userId: owner, projectId: operations.id, fileIds: [fileId, handbookFile.id] },
        operands,
        50,
      );
      expect(chunks.length).toBeGreaterThan(0);
      expect(new Set(chunks.map((chunk) => chunk.attachmentId))).toEqual(
        new Set([handbookFile.id]),
      );
    }
  });

  describe('leaving files out of a message', () => {
    it('searches only the files that are left in, and names the ones left out', async () => {
      smallModel(3200);
      const { operations, handbookFile } = await largeProject('Leave out');
      const chat = await thread(operations.id);
      const started = await send(chat.id, 'What is the launch code for Operation Kestrel?', {
        excludedProjectFileIds: [handbookFile.id, handbookFile.id],
      });
      const text = await modelText(started);
      expect(text).not.toContain(KESTREL);
      expect(text).not.toContain('handbook.txt');
      expect(started.turn.projectSearchPart?.data).toEqual({
        mode: 'search',
        files: [],
        excluded: [{ name: 'handbook.txt' }],
      });

      // Only that message: the next one uses every file again.
      const next = await send(
        (await thread(operations.id)).id,
        'What is the launch code for Operation Kestrel?',
      );
      expect(await modelText(next)).toContain(KESTREL);
      expect(next.turn.projectSearchPart?.data.excluded).toBeUndefined();
    });

    it('adds the files left out to a note that lists passages', async () => {
      smallModel(3200);
      const { operations, appendixFile } = await largeProject('Leave one out');
      const started = await send(
        (await thread(operations.id)).id,
        'What is the launch code for Operation Kestrel?',
        { excludedProjectFileIds: [appendixFile.id] },
      );
      expect(await modelText(started)).toContain(KESTREL);
      expect(started.turn.projectSearchPart?.data).toMatchObject({
        files: [{ name: 'handbook.txt' }],
        excluded: [{ name: 'appendix.txt' }],
      });
    });

    it('leaves a small file out of a project that is included whole', async () => {
      const small = await project('Small, leave out');
      const facts = await projectFile(small.id, 'facts.txt', 'The codename is Blue Heron.');
      await projectFile(small.id, 'other.txt', 'Other notes.');
      const started = await send((await thread(small.id)).id, 'What is the codename?', {
        excludedProjectFileIds: [facts.id],
      });
      const text = await modelText(started);
      expect(text).not.toContain('Blue Heron');
      expect(text).toContain('Other notes.');
      expect(started.turn.projectSearchPart?.data).toEqual({
        mode: 'search',
        files: [],
        excluded: [{ name: 'facts.txt' }],
      });
    });

    it('refuses files that are not this project’s, before anything is stored', async () => {
      const mine = await project('Refuse');
      await projectFile(mine.id, 'mine.txt', 'Mine.');
      const otherProject = await project('Refuse other');
      const sibling = await projectFile(otherProject.id, 'sibling.txt', 'Sibling.');
      const stranger = await seedUser(pool.db, state.organizationId);
      const theirs = await project('Refuse theirs', stranger);
      const foreign = await projectFile(theirs.id, 'theirs.txt', 'Theirs.', { userId: stranger });
      const chat = await thread(mine.id);
      for (const id of [sibling.id, foreign.id, 'no-such-file']) {
        await expect(
          send(chat.id, 'Hello', { excludedProjectFileIds: [id] }),
        ).rejects.toMatchObject({ status: 422 });
      }
      const loose = await thread(null);
      await expect(
        send(loose.id, 'Hello', { excludedProjectFileIds: [sibling.id] }),
      ).rejects.toThrow('Files can only be left out in a conversation that is in a project.');
      const messages = await pool.db
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(eq(schema.message.threadId, chat.id));
      expect(messages).toEqual([]);
      // A file deleted since the composer listed it is still accepted.
      const gone = await projectFile(mine.id, 'gone.txt', 'Gone.');
      await pool.db
        .update(schema.attachment)
        .set({ deletedAt: new Date() })
        .where(eq(schema.attachment.id, gone.id));
      await expect(
        send(chat.id, 'Hello', { excludedProjectFileIds: [gone.id] }),
      ).resolves.toBeTruthy();
    });

    it('rejects more ids than a project can have files', async () => {
      const { sendMessageSchema } = await import('@oci/shared');
      const parsed = sendMessageSchema.safeParse({
        threadId: 't',
        modelSlug: 'm',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        excludedProjectFileIds: Array.from({ length: 21 }, (_, index) => `f${index}`),
      });
      expect(parsed.success).toBe(false);
    });
  });
});
