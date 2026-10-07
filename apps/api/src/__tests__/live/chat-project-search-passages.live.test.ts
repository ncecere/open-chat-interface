import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { PROJECT_EXCERPT_MAX_CHARS } from '@oci/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendix,
  assembledCost,
  handbook,
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
import { fitsContext, textCost } from '../../services/chat/context-budget.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Large project files in the model context: when a project's files do not
 * all fit, the latest message searches their chunks and only the best
 * passages reach the model. Admission, budgeting, retrieval, persistence and
 * SDK conversion are real; setupTurn stops before any provider is called, and
 * the assembled model input is what these tests inspect.
 *
 * This file: which passages and files reach the model, within its budget.
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
const { PROJECT_PASSAGE_SHARE } = await import('../../services/chat/project-context.js');
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

    // Marked with names, counts and the start of each passage used (v0.10),
    // never the whole passage.
    expect(started.turn.projectSearchPart).toEqual({
      type: 'data-project-search',
      id: expect.stringMatching(/^project-search-/),
      data: {
        mode: 'search',
        ranking: 'keyword',
        files: [
          {
            name: 'handbook.txt',
            passages: expect.any(Number),
            excerpts: [
              {
                id: expect.stringMatching(/:\d+-\d+$/),
                first: expect.any(Number),
                last: expect.any(Number),
                snippet: expect.any(String),
              },
            ],
          },
        ],
      },
    });
    const [excerpt] = started.turn.projectSearchPart!.data.files[0]!.excerpts!;
    expect(excerpt!.snippet.length).toBeLessThanOrEqual(PROJECT_EXCERPT_MAX_CHARS + 1);
    expect(text.replace(/\s+/g, ' ')).toContain(excerpt!.snippet.replace(/…$/, ''));
    const stored = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, chat.id));
    // The prompt and the model input are not stored; the reply part holds only the excerpt.
    expect(JSON.stringify(stored)).not.toContain('Handbook section 24 covers');
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

  it('names the files but adds no passage when nothing matches or there is nothing to search for', async () => {
    const budget = smallModel();
    const { operations } = await largeProject('Nothing matches');
    // No words at all; words the files lack; words in every passage ("the", "for", "of").
    for (const message of ['?! … —', 'Tell me about walruses', 'the rota for the week of']) {
      const started = await send((await thread(operations.id)).id, message);
      const text = await modelText(started);
      expect(text).not.toContain('Passage');
      expect(text).not.toContain('Handbook section');
      expect(text).not.toContain('Appendix note');
      expect(text).toContain(
        'Files from the project "Nothing matches". They are reference material for every conversation in the project, not files attached to this message. The project\'s files (handbook.txt, appendix.txt) are too long to include in full, so passages that match each message are included instead; none matched the latest message closely enough.',
      );
      // No note on the reply: there is nothing to show.
      expect(started.turn.projectSearchPart).toBeNull();
      expect(started.turn.contextLimited).toBe(false);
      expect(fitsContext(assembledCost(started), budget)).toBe(true);
    }
  });

  it('still includes unsearchable files whole when nothing matches', async () => {
    smallModel();
    const { operations } = await largeProject('Nothing matches, with a note');
    await projectFile(operations.id, 'note.txt', 'NOTE_FILE fits.', { index: false });
    const started = await send((await thread(operations.id)).id, 'Tell me about walruses');
    const text = await modelText(started);
    expect(text).toContain("The project's files (handbook.txt, appendix.txt) are too long");
    expect(text).toContain('Attached file "note.txt":\n\nNOTE_FILE fits.');
    expect(text).not.toContain('Passage');
    expect(started.turn.projectSearchPart).toBeNull();
    expect(started.turn.contextLimited).toBe(false);
  });

  it('leaves out the file names too when not even they fit', async () => {
    // The question leaves 300 units: less than the note naming the files.
    const budget = smallModel(3000);
    const { operations } = await largeProject('No room');
    const question = `walruses ${'x'.repeat(budget.units - 300 - 2 * 64 - 2 * 16 - 'INSTANCE PROMPT'.length - 'walruses '.length)}`;
    const started = await send((await thread(operations.id)).id, question);
    const text = await modelText(started);
    expect(text).not.toContain('too long to include in full');
    expect(started.turn.projectSearchPart).toBeNull();
    expect(fitsContext(assembledCost(started), budget)).toBe(true);
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

  it('names the section a passage comes from when the file has headings', async () => {
    smallModel();
    const guide = await project('Guide');
    const body = Array.from({ length: 30 }, (_, index) =>
      index === 0
        ? '# Staff guide'
        : index === 20
          ? '## Field trips'
          : index === 24
            ? 'Osprey watching trips leave from the north gate at dawn.'
            : `Paragraph ${index} is filler text about routine matters for everyone.`,
    ).join('\n\n');
    await projectFile(guide.id, 'guide.md', body, { mimeType: 'text/markdown' });
    await projectFile(guide.id, 'appendix.txt', appendix());
    const started = await send((await thread(guide.id)).id, 'When do osprey trips leave?');
    const [file] = started.turn.projectSearchPart!.data.files;
    expect(file?.name).toBe('guide.md');
    expect(file?.excerpts?.[0]?.heading).toBe('Field trips');
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
