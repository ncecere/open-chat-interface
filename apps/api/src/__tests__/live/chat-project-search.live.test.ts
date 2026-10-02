import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  addCost,
  contextBudget,
  fitsContext,
  MESSAGE_OVERHEAD,
  messageCost,
  textCost,
} from '../../services/chat/context-budget.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Large project files in the model context: when a project's files do not
 * all fit, the latest message searches their chunks and only the best
 * passages reach the model. Admission, budgeting, retrieval, persistence and
 * SDK conversion are real; setupTurn stops before any provider is called, and
 * the assembled model input is what these tests inspect.
 */
type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
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
const { indexedChunkCounts, openingProjectChunks, rankProjectChunks, projectSearchTerms } =
  await import('../../services/project-search/retrieval.js');
const { PROJECT_PASSAGE_SHARE } = await import('../../services/chat/project-context.js');

async function modelText(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages
    .flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function assembledCost(started: StartedTurn) {
  const system = textCost(started.turn.system);
  return started.turn.uiMessages.reduce((sum, message) => addCost(sum, messageCost(message)), {
    ...system,
    units: system.units + MESSAGE_OVERHEAD,
  });
}

const KESTREL = 'The launch code for Operation Kestrel is PELICAN-42, kept in the blue folder.';

/** A long handbook where exactly one paragraph is about Operation Kestrel. */
function handbook(): string {
  return Array.from({ length: 40 }, (_, index) =>
    index === 25
      ? KESTREL
      : `Handbook section ${index} covers the routine upkeep of the office kitchen and the rota for the week ahead.`,
  ).join('\n\n');
}

/** A long appendix sharing no words with the question. */
function appendix(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `Appendix note ${index} lists zebra xylophone quokka marmalade inventory values alphabetically.`,
  ).join('\n\n');
}

/** Input budget of 6,000 units by default: room for two passages in the search share. */
function smallModel(units = 6000) {
  state.contextWindow = units + 1000 + 512;
  state.maxOutputTokens = 1000;
  return contextBudget({
    contextWindow: state.contextWindow,
    maxOutputTokens: state.maxOutputTokens,
  });
}

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
    text: string | null,
    options: { userId?: string; index?: boolean; mimeType?: string } = {},
  ) {
    const body = text ?? 'binary';
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: options.userId ?? owner,
        projectId,
        filename,
        mimeType: options.mimeType ?? 'text/plain',
        sizeBytes: Buffer.byteLength(body),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    await driver.put(row!.storageKey, Buffer.from(body), options.mimeType ?? 'text/plain');
    if (options.index !== false) await indexProjectFile(row!.id);
    return row!;
  }
  async function thread(projectId: string | null) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, projectId })
      .returning();
    return row!;
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: owner, name: 'Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
        ...extra,
      },
    );
    runs.add(started.run);
    return started;
  }
  async function largeProject(name = 'Operations') {
    const operations = await project(name);
    const handbookFile = await projectFile(operations.id, 'handbook.txt', handbook());
    const appendixFile = await projectFile(operations.id, 'appendix.txt', appendix());
    return { operations, handbookFile, appendixFile };
  }

  it('includes a small project whole, as before, even when indexed', async () => {
    const small = await project('Small');
    await projectFile(small.id, 'facts.txt', 'The codename is Blue Heron.');
    const started = await send((await thread(small.id)).id, 'What is the codename?');
    const text = await modelText(started);
    expect(text).toContain('Attached file "facts.txt":\n\nThe codename is Blue Heron.');
    expect(text).not.toContain('Passage');
    expect(started.turn.projectSearchPart).toBeNull();
    expect(started.turn.contextLimited).toBe(false);
  });

  it('gives the model the passage that answers the question, not unrelated ones', async () => {
    // A share of 1,600 units holds one passage: it must be the best one.
    const budget = smallModel(3200);
    const { operations } = await largeProject();
    const chat = await thread(operations.id);
    const started = await send(chat.id, 'What is the launch code for Operation Kestrel?');
    const text = await modelText(started);

    expect(text).toContain(KESTREL);
    expect(text).toContain('too long to include in full');
    expect(text).toMatch(/Passages? \d+(–\d+)? of project file "handbook\.txt":/);
    // Sections that only share common words such as "the" and "for" lose to it.
    expect(text).not.toContain('Handbook section 0 ');
    expect(text).not.toContain('Handbook section 39 ');
    expect(text).not.toContain('Appendix note');
    expect(text.split(KESTREL)).toHaveLength(2);
    expect(text.indexOf(KESTREL)).toBeLessThan(
      text.indexOf('What is the launch code for Operation Kestrel?'),
    );
    expect(started.turn.contextLimited).toBe(false);
    expect(fitsContext(assembledCost(started), budget)).toBe(true);

    // Marked with names and counts only; nothing of the passages is stored.
    expect(started.turn.projectSearchPart).toEqual({
      type: 'data-project-search',
      id: expect.stringMatching(/^project-search-/),
      data: {
        mode: 'search',
        ranking: 'keyword',
        files: [{ name: 'handbook.txt', passages: expect.any(Number) }],
      },
    });
    expect(JSON.stringify(started.turn.projectSearchPart)).not.toContain('PELICAN');
    const stored = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, chat.id));
    expect(JSON.stringify(stored)).not.toContain('PELICAN');
  });

  it('keeps passages within their share of the budget, ordered by file and position', async () => {
    const budget = smallModel();
    const operations = await project('Ordered');
    const first = Array.from({ length: 30 }, (_, index) =>
      index === 3 || index === 27
        ? `Gamma marker ${index}: the walrus inventory is counted here.`
        : `Filler line ${index} about nothing in particular at all, padded out further.`,
    ).join('\n\n');
    await projectFile(operations.id, 'first.txt', first);
    await projectFile(operations.id, 'second.txt', `${appendix()}\n\nWalrus inventory closes.`);

    const started = await send((await thread(operations.id)).id, 'walrus inventory');
    const text = await modelText(started);
    const passages = started.turn.uiMessages[0]!.parts.flatMap((part) =>
      part.type === 'text' && part.text.includes(' of project file "') ? [part.text] : [],
    );
    const passageUnits = passages.reduce((sum, part) => sum + textCost(part).units, 0);
    expect(passageUnits).toBeLessThanOrEqual(budget.units * PROJECT_PASSAGE_SHARE);
    expect(passages.length).toBeGreaterThan(0);
    // File order first (first.txt before second.txt), then position in the file.
    const order = passages.map((part) => {
      const [, number, name] = /^Passages? (\d+)(?:–\d+)? of project file "([^"]+)"/.exec(part)!;
      return [name === 'first.txt' ? 1 : 2, Number(number)] as const;
    });
    const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(order).toEqual(sorted);
    expect(new Set(order.map(([file]) => file))).toEqual(new Set([1, 2]));
    expect(text).toContain('Gamma marker 3:');
    expect(fitsContext(assembledCost(started), budget)).toBe(true);
  });

  it('uses the opening passages of each file when the message has nothing to search for', async () => {
    smallModel();
    const { operations } = await largeProject('Opening');
    for (const message of ['?! … —', 'Tell me about walruses']) {
      const started = await send((await thread(operations.id)).id, message);
      const text = await modelText(started);
      expect(text).toContain('opening passages of each file');
      expect(text).toContain('Handbook section 0 ');
      expect(text).toContain('Appendix note 0 ');
      expect(text).not.toContain(KESTREL);
      expect(started.turn.projectSearchPart?.data).toEqual({
        mode: 'opening',
        files: [
          { name: 'handbook.txt', passages: 1 },
          { name: 'appendix.txt', passages: 1 },
        ],
      });
    }
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
      expect.arrayContaining(["'brien':*", "'kestrel-nest':*", "'kestrel':*", "'nest':*", "'of'"]),
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
    expect(await openingProjectChunks({ ...mine, fileIds: [] }, 10)).toEqual([]);
    expect(await openingProjectChunks(mine, 0)).toEqual([]);
    expect(await indexedChunkCounts([])).toEqual(new Map());
    expect(
      (await openingProjectChunks({ ...mine, fileIds: [foreign.id, sibling.id] }, 10)).length,
    ).toBe(0);
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

  it('still includes unsearchable files whole when they fit, and marks any left out', async () => {
    smallModel();
    const { operations } = await largeProject('Mixed');
    await projectFile(operations.id, 'photo.png', null, { mimeType: 'image/png' });
    // Not indexed yet (as before the background job runs) and too large to fit.
    await projectFile(operations.id, 'pending.txt', `PENDING_FILE ${'p '.repeat(4000)}`, {
      index: false,
    });

    const started = await send(
      (await thread(operations.id)).id,
      'What is the launch code for Operation Kestrel?',
    );
    const text = await modelText(started);
    expect(text).toContain(KESTREL);
    expect(text).toContain('Attached file "photo.png" (image/png) could not be read.');
    expect(text).not.toContain('PENDING_FILE');
    expect(started.turn.contextLimited).toBe(true);
  });

  it('falls back to whole files that fit when no passage fits', async () => {
    // 1,500 units: the passage share (750) is smaller than any chunk.
    state.contextWindow = 1500 + 500 + 512;
    state.maxOutputTokens = 500;
    const operations = await project('Tiny');
    await projectFile(operations.id, 'handbook.txt', handbook());
    await projectFile(operations.id, 'note.txt', 'NOTE_FILE fits.', { index: false });

    const started = await send((await thread(operations.id)).id, 'Operation Kestrel');
    const text = await modelText(started);
    expect(text).toContain('NOTE_FILE fits.');
    expect(text).not.toContain('Passage');
    expect(started.turn.projectSearchPart).toBeNull();
    expect(started.turn.contextLimited).toBe(true);
  });
});
