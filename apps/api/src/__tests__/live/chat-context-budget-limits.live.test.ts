import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, sql } from '@oci/db';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { budgetHelpers, sdkText } from '../../../test/chat-context-budget.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type * as attachmentContext from '../../services/chat/attachment-context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Bounded model context: turn preparation (setupTurn) through real PostgreSQL
 * and local blob storage, stopping before any provider call.
 *
 * This file: the input budget, output caps and search grounding.
 * The shared helpers are in test/chat-context-budget.fixtures.ts; the other
 * chat-context-budget-*.live.test.ts files cover the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  providerKind: 'openai',
  modelId: 'budget-test-model',
  contextWindow: undefined as number | undefined,
  maxOutputTokens: undefined as number | undefined,
  system: '',
  grounding: '',
  maxFilesPerMessage: 100,
  released: 0,
  quotaReleased: 0,
  abandoned: 0,
  unregistered: 0,
  inference: vi.fn(() => {
    throw new Error('These tests must never invoke inference');
  }),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// Only environmental services and policy are stubbed. Admission, PostgreSQL
// history/size queries, attachment selection, blob I/O, persistence and SDK
// conversion are real. setupTurn stops before any provider invocation.
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'budget-test-model',
    capabilities: ['vision'],
    supportedEfforts: ['instant', 'low', 'medium', 'high'],
    providerKind: state.providerKind,
    contextWindow: state.contextWindow,
    maxOutputTokens: state.maxOutputTokens,
    languageModel: {
      modelId: state.modelId,
      doGenerate: state.inference,
      doStream: state.inference,
    },
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: true, temporaryChat: true };
    // Deliberately looser than the model-input file ceiling.
    if (key === 'storage') return { maxFilesPerMessage: state.maxFilesPerMessage };
    // No saved role overrides: built-in role defaults apply.
    if (key === 'roleFeatures') return {};
    // These tests cover trimming without summaries (chat-compaction covers those).
    if (key === 'chat') return { autoCompact: false };
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => state.system,
}));
vi.mock('../../services/search/index.js', () => ({
  normalizeSearchQuery: (text: string) => text.trim(),
  searchWeb: async () => ({
    results: [{ title: 'Fixture', url: 'https://example.test/source' }],
    provider: 'Fixture search',
    fallback: false,
  }),
  buildGroundingContext: () => state.grounding,
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({
    release: async () => {
      state.released++;
    },
  }),
}));
vi.mock('../../services/quota/index.js', () => ({
  reserveQuotaForRun: async (input: { runId: string; userId: string; modelSlug: string }) => ({
    id: input.runId,
    userId: input.userId,
    modelSlug: input.modelSlug,
    pricing: { inputPriceMicros: null, outputPriceMicros: null },
  }),
  releaseReservation: async () => {
    state.quotaReleased++;
  },
  settleReservation: async () => {},
  recordUsage: async () => {},
}));
vi.mock('../../services/chat-streams.js', () => ({
  beginChatRun: async () => 'available',
  abandonChatRun: async () => {
    state.abandoned++;
  },
  unregisterLocalChatRun: () => {
    state.unregistered++;
  },
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live bounded model context', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let driver: LocalStorageDriver;
  let getBlob: MockInstance<LocalStorageDriver['get']>;
  let materialize: MockInstance<typeof attachmentContext.materializeAttachments>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('context_budget');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-context-budget-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
  });
  beforeEach(async () => {
    state.providerKind = 'openai';
    state.modelId = 'budget-test-model';
    state.contextWindow = undefined;
    state.maxOutputTokens = undefined;
    state.system = '';
    state.grounding = '';
    state.maxFilesPerMessage = 100;
    state.released = 0;
    state.quotaReleased = 0;
    state.abandoned = 0;
    state.unregistered = 0;
    state.inference.mockClear();
    getBlob = vi.spyOn(driver, 'get');
    // These spies call through: they observe the real metadata/selection boundary.
    materialize = vi.spyOn(
      await import('../../services/chat/attachment-context.js'),
      'materializeAttachments',
    );
  });
  afterEach(async () => {
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    expect(state.inference).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const { thread, messages, attachment, seedHistory, send, expectRejected } = budgetHelpers({
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
    get getBlob() {
      return getBlob;
    },
    get materialize() {
      return materialize;
    },
    state,
  });

  it('rejects an oversized latest message before persistence and releases all admission handles', async () => {
    state.contextWindow = 4096;
    const chat = await thread();
    const file = await attachment();
    await expectRejected(chat.id, 'L'.repeat(3000), [file]);
  });

  it('rejects oversized mandatory system instructions rather than dropping them', async () => {
    state.contextWindow = 4096;
    state.system = 'S'.repeat(3000);
    const chat = await thread();
    const file = await attachment();
    await expectRejected(chat.id, 'Short latest message', [file]);
  });

  it('rejects latest + system + document together even when each individually fits', async () => {
    state.contextWindow = 4096;
    state.system = 'S'.repeat(900);
    const chat = await thread();
    const file = await attachment({ text: 'D'.repeat(900) });
    // 4096 - 1024 output - 512 margin = 2560 units, before framing overhead.
    await expectRejected(chat.id, 'L'.repeat(900), [file]);
  });

  it('uses UTF-8 bytes, not JS string length or a chars/4 estimate', async () => {
    state.contextWindow = 4096;
    const ascii = 'a'.repeat(1800);
    const unicode = '界'.repeat(1800);
    expect(unicode.length).toBe(ascii.length);
    expect(Buffer.byteLength(unicode)).toBe(5400);
    const accepted = await send((await thread()).id, ascii);
    expect(await sdkText(accepted)).toBe(ascii);
    expect(accepted.turn.contextLimited).toBe(false);
    materialize.mockClear();
    await expectRejected((await thread()).id, unicode);
  });

  it('splits the reserved Anthropic output total before persisting the turn', async () => {
    state.providerKind = 'anthropic';
    state.modelId = 'claude-sonnet-4-20250514';
    const started = await send((await thread()).id, 'Think', { effort: 'high' });
    const settings = started.turn.generationSettings;
    expect(started.turn.resolved.maxOutputTokens).toBe(4096);
    expect(settings.maxOutputTokens).toBe(1638);
    expect(settings).toMatchObject({
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 2458 },
        },
      },
    });
  });

  it('rejects an output cap too small for legacy thinking before saving the prompt', async () => {
    state.providerKind = 'anthropic';
    state.modelId = 'claude-sonnet-4-20250514';
    state.maxOutputTokens = 1024;
    await expectRejected(
      (await thread()).id,
      'Think',
      [],
      { effort: 'high' },
      { message: 'at least 1025' },
    );
  });

  it('sends fitting search grounding to the model without writing it into the saved user turn', async () => {
    state.grounding = 'SEARCH_MODEL_ONLY';
    const chat = await thread();
    const started = await send(chat.id, 'Original question', { webSearch: true });
    expect(await sdkText(started)).toBe('Original question\nSEARCH_MODEL_ONLY');
    expect(started.turn.sourceParts).toEqual([
      {
        type: 'source-url',
        sourceId: 'search-1',
        url: 'https://example.test/source',
        title: 'Fixture',
      },
    ]);
    expect(started.turn.searchGroundingPart?.data.query).toBe('Original question');
    expect((await messages(chat.id))[0]?.parts).toEqual([
      { type: 'text', text: 'Original question' },
    ]);
  });

  it('returns explicit/default output caps and contextLimited=false when everything fits', async () => {
    const cases = [
      { window: undefined, output: undefined, expected: 4096 },
      { window: 65_536, output: 2048, expected: 2048 },
      { window: 4096, output: undefined, expected: 1024 },
    ];
    for (const fixture of cases) {
      state.contextWindow = fixture.window;
      state.maxOutputTokens = fixture.output;
      state.system = 'MANDATORY_SYSTEM';
      const chat = await thread();
      await seedHistory(chat.id, [
        { role: 'user', text: 'EARLIER_USER' },
        { role: 'assistant', text: 'EARLIER_REPLY' },
      ]);
      const started = await send(chat.id, 'LATEST_REQUIRED');
      expect(started.turn.resolved.maxOutputTokens).toBe(fixture.expected);
      expect(started.turn.contextLimited).toBe(false);
      expect(started.turn.system).toBe('MANDATORY_SYSTEM');
      expect(await sdkText(started)).toBe('EARLIER_USER\nEARLIER_REPLY\nLATEST_REQUIRED');
      expect(await messages(chat.id)).toHaveLength(4);
    }
  });

  it('keeps search grounding mandatory and rejects its aggregate budget before persistence', async () => {
    state.contextWindow = 4096;
    state.system = 'S'.repeat(900);
    state.grounding = `SEARCH_EVIDENCE_${'g'.repeat(900)}`;
    const chat = await thread();
    const file = await attachment({ text: 'small document' });
    await expectRejected(chat.id, 'Q'.repeat(900), [file], { webSearch: true });
  });

  it('enforces the default 32768 window, 512-unit margin and absolute 128000 input ceiling', async () => {
    // Empty system still has framing: 80 units; latest text has 80 units.
    // 32768 - 4096 - 512 - 160 = 28000 UTF-8 bytes of latest text.
    const boundary = await send((await thread()).id, 'b'.repeat(28_000));
    expect(await sdkText(boundary)).toHaveLength(28_000);
    expect(boundary.turn.resolved.maxOutputTokens).toBe(4096);
    expect(boundary.turn.contextLimited).toBe(false);
    materialize.mockClear();
    await expectRejected((await thread()).id, 'b'.repeat(28_001));
    state.contextWindow = 1_000_000;
    state.maxOutputTokens = 4096;
    await expectRejected((await thread()).id, 'x'.repeat(128_001));
  });
});
