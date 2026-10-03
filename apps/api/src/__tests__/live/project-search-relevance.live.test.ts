import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, schema, sql } from '@oci/db';
import { convertToModelMessages } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { contextBudget } from '../../services/chat/context-budget.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * The relevance floor of project search, proved on the files that showed the
 * problem: a large staff handbook and a research guide (synthetic test files,
 * in test/fixtures/project-search). Before the floor, "write b tree in rust,
 * go, zig" filled the whole passage share (55 passages) because every chunk
 * shares a word such as "in" with it. Now a question about something the files
 * do not cover adds no passages and no note, a specific question gets the
 * passage that answers it first, and a broad on-topic question gets the
 * passages about that topic only.
 *
 * Keyword search only (no embeddings or reranking configured), with a large
 * model, so the passage share is 64,000 units: far more than any answer needs.
 */
type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
const MODEL = { contextWindow: 200_000, maxOutputTokens: 4096 };
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 4096,
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
    if (key === 'chat') return {};
    if (key === 'embeddings') return {};
    if (key === 'reranking') return {};
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => 'INSTANCE PROMPT',
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
const { extractText } = await import('../../services/attachments/extract.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { projectSearchTerms, rankProjectChunks } = await import(
  '../../services/project-search/retrieval.js'
);
const { PROJECT_PASSAGE_SHARE } = await import('../../services/chat/project-context.js');

const FIXTURES = new URL('../../../test/fixtures/project-search/', import.meta.url);
const HANDBOOK = 'northbrook-staff-handbook.txt';
const GUIDE = 'northbrook-research-guide.md';

/** Section titles by start offset: "Section 97. Purchasing" or "## 8. Data Management Plans". */
function sectionIndex(text: string) {
  return [...text.matchAll(/^(?:Section \d+\. |## \d+\. )(.+)$/gm)].map((match) => ({
    start: match.index,
    title: match[1]!,
  }));
}

async function modelText(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages
    .flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

/** The passages a turn gave the model, as rendered. */
function passagesOf(started: StartedTurn): string[] {
  return started.turn.uiMessages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === 'text' && /^Passages? \d+(–\d+)? of project file "/.test(part.text)
        ? [part.text]
        : [],
    ),
  );
}

describe.skipIf(!available)('live: only relevant project passages are used', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let projectId: string;
  const files = new Map<string, { id: string; text: string }>();
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('project_search_relevance');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-project-relevance-'));
    state.driver = new LocalStorageDriver(root);
    const [project] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId: owner, name: 'Northbrook' })
      .returning();
    projectId = project!.id;
    for (const [filename, mimeType] of [
      [GUIDE, 'text/markdown'],
      [HANDBOOK, 'text/plain'],
    ] as const) {
      const bytes = await readFile(new URL(filename, FIXTURES));
      // As uploaded: the handbook is longer than extraction keeps (200,000 characters).
      const text = (await extractText(mimeType, bytes))!;
      const [row] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId: owner,
          projectId,
          filename,
          mimeType,
          sizeBytes: bytes.byteLength,
          storageKey: randomUUID(),
          extractedText: text,
        })
        .returning();
      await state.driver.put(row!.storageKey, bytes, mimeType);
      expect(await indexProjectFile(row!.id)).toBe(true);
      files.set(filename, { id: row!.id, text });
    }
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

  async function send(text: string) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId, projectId })
      .returning();
    const started = await setupTurn(
      { id: owner, name: 'Test User', role: 'user' },
      {
        threadId: thread!.id,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
      },
    );
    runs.add(started.run);
    return started;
  }

  /** Passages (chunks) per file, from the reply's note. */
  function counts(started: StartedTurn) {
    return Object.fromEntries(
      (started.turn.projectSearchPart?.data.files ?? []).map((file) => [file.name, file.passages]),
    );
  }

  /** The best-ranked chunk for a question, and the sections it overlaps. */
  async function best(question: string) {
    const scope = { userId: owner, projectId, fileIds: [...files.values()].map((f) => f.id) };
    const [top] = await rankProjectChunks(scope, await projectSearchTerms(question), 160);
    expect(top).toBeDefined();
    const filename = top!.filename;
    const sections = sectionIndex(files.get(filename)!.text);
    const overlapping = sections.filter(
      (section, index) =>
        section.start < top!.end && (sections[index + 1]?.start ?? Infinity) > top!.start,
    );
    return { filename, content: top!.content, sections: overlapping.map((s) => s.title) };
  }

  it('is a project too large to include whole, so its files are searched', () => {
    const budget = contextBudget(MODEL);
    expect(budget.units).toBe(128_000);
    expect(files.get(HANDBOOK)!.text.length).toBe(200_000);
    expect(files.get(HANDBOOK)!.text).toContain('AMBER-42');
    expect(budget.units * PROJECT_PASSAGE_SHARE).toBe(64_000);
  });

  it.each(['write b tree in rust, go, zig', 'write a poem about the sea', 'what is 2+2'])(
    'adds no passages and no note for an unrelated question: %s',
    async (question) => {
      const started = await send(question);
      const text = await modelText(started);
      expect(passagesOf(started)).toEqual([]);
      expect(started.turn.projectSearchPart).toBeNull();
      expect(started.turn.contextLimited).toBe(false);
      // One short note tells the model the files exist, so it can say what to ask.
      expect(text).toContain(
        `The project's files (${GUIDE}, ${HANDBOOK}) are too long to include in full`,
      );
      expect(text.length).toBeLessThan(1000);
    },
  );

  it.each([
    { question: 'What is AMBER-42?', file: HANDBOOK, section: 'Purchasing', needle: 'AMBER-42' },
    {
      question: 'Where is the key for the Harlow Room kept?',
      file: HANDBOOK,
      section: 'Purchasing',
      needle: "porter's lodge, cabinet 7",
    },
    {
      question: 'How do I get a parking permit?',
      file: HANDBOOK,
      section: 'Parking Permits',
      needle: 'Parking permits',
    },
    {
      question: 'Who approves conference funding?',
      file: HANDBOOK,
      section: 'Conference Funding',
      needle: 'Conference funding',
    },
    {
      question: 'What are the rules for visitor badges?',
      file: HANDBOOK,
      section: 'Visitor Badges',
      needle: 'Visitor badges',
    },
    {
      question: 'What goes in a data management plan?',
      file: GUIDE,
      section: 'Data Management Plans',
      needle: 'Data management plans',
    },
  ])(
    'ranks the section that answers "$question" first and adds only relevant passages',
    async ({ question, file, section, needle }) => {
      const top = await best(question);
      expect(top.filename).toBe(file);
      expect(top.sections).toContain(section);
      expect(top.content).toContain(needle);

      const started = await send(question);
      const passages = passagesOf(started);
      expect(passages.length).toBeGreaterThan(0);
      // Every passage is about what was asked: none is there for "the" or "is".
      for (const passage of passages) expect(passage.toLowerCase()).toContain(needle.toLowerCase());
      expect(Object.keys(counts(started))).toEqual([file]);
      expect(started.turn.projectSearchPart?.data).toMatchObject({ mode: 'search' });
    },
  );

  it('answers a broad on-topic question with that topic’s passages, not the whole share', async () => {
    const started = await send('summarise the leave policy');
    const passages = passagesOf(started);
    const chunks = counts(started)[HANDBOOK] ?? 0;
    expect(Object.keys(counts(started))).toEqual([HANDBOOK]);
    expect(chunks).toBeGreaterThan(5);
    // The annual leave sections only: well under the 50-odd chunks the share holds.
    expect(chunks).toBeLessThanOrEqual(20);
    for (const passage of passages) expect(passage).toMatch(/leave/i);
  });
});
