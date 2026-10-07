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
import {
  budgetHelpers,
  type HistoryRow,
  sdkMessages,
  sdkText,
} from '../../../test/chat-context-budget.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type * as attachmentContext from '../../services/chat/attachment-context.js';
import type * as contextHistory from '../../services/chat/context-history.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Bounded model context: turn preparation (setupTurn) through real PostgreSQL
 * and local blob storage, stopping before any provider call.
 *
 * This file: the history window, stored payload ceilings and regeneration.
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
  let loadHistory: MockInstance<typeof contextHistory.loadContextHistory>;
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
    loadHistory = vi.spyOn(
      await import('../../services/chat/context-history.js'),
      'loadContextHistory',
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

  it('caps 211 historical turns at 128 rows, retaining the newest whole-turn suffix without an orphan', async () => {
    const chat = await thread();
    const rows: HistoryRow[] = Array.from({ length: 211 }, (_, index) => [
      { role: 'user' as const, text: `USER_${index}` },
      { role: 'assistant' as const, text: `ASSISTANT_${index}` },
    ]).flat();
    // 423 rows means the 128-row cutoff begins on an assistant.
    rows.push({ role: 'user', text: 'NEWEST_STORED_USER' });
    const seeded = await seedHistory(chat.id, rows);
    const before = await messages(chat.id);
    const started = await send(chat.id, 'LATEST_REQUIRED');
    const history = await loadHistory.mock.results[0]!.value;
    expect(history.history).toHaveLength(128);
    expect(started.turn.uiMessages.slice(0, -1).map((message) => message.id)).toEqual(
      seeded.slice(-127).map((message) => message.id),
    );
    const sdk = await sdkMessages(started);
    expect(sdk).toHaveLength(128);
    expect(sdk[0]?.role).toBe('user');
    for (const [index, message] of sdk.entries()) {
      if (message.role === 'assistant') expect(sdk[index - 1]?.role).toBe('user');
    }
    expect(await sdkText(started)).toContain('ASSISTANT_210');
    expect(await sdkText(started)).toContain('NEWEST_STORED_USER');
    expect(await sdkText(started)).not.toContain('USER_0\n');
    expect(started.turn.contextLimited).toBe(true);
    expect((await messages(chat.id)).slice(0, before.length)).toEqual(before);
  });

  it('does not cherry-pick a cheap older turn across a huge recent turn', async () => {
    state.contextWindow = 4096;
    const chat = await thread();
    const seeded = await seedHistory(chat.id, [
      { role: 'user', text: 'OLDER_CHEAP_USER' },
      { role: 'assistant', text: 'OLDER_CHEAP_REPLY' },
      { role: 'user', text: `HUGE_RECENT_USER_${'x'.repeat(4000)}` },
      { role: 'assistant', text: 'HUGE_RECENT_REPLY' },
      { role: 'user', text: 'NEWEST_SMALL_USER' },
      { role: 'assistant', text: 'NEWEST_SMALL_REPLY' },
    ]);
    const started = await send(chat.id, 'LATEST_REQUIRED');
    expect(started.turn.uiMessages.slice(0, -1).map((message) => message.id)).toEqual(
      seeded.slice(-2).map((message) => message.id),
    );
    expect(await sdkText(started)).toBe('NEWEST_SMALL_USER\nNEWEST_SMALL_REPLY\nLATEST_REQUIRED');
    expect(started.turn.contextLimited).toBe(true);
  });

  it('regenerates only the latest turn, with its own file but not the reply it replaces', async () => {
    const chat = await thread();
    const early = await attachment({ text: 'ORIGINAL_DOCUMENT_CONTENT' });
    const rows: HistoryRow[] = [
      ...Array.from({ length: 80 }, (_, index) => [
        { role: 'user' as const, text: `EARLIER_USER_${index}` },
        { role: 'assistant' as const, text: `EARLIER_ANSWER_${index}` },
      ]).flat(),
      { role: 'user', text: 'Same prompt', files: [early] },
      { role: 'assistant', text: 'ORIGINAL_ANSWER_NOT_INPUT' },
    ];
    const seeded = await seedHistory(chat.id, rows);
    const target = seeded.at(-2)!;
    // An earlier turn is fixed, even far beyond the 128-row history window.
    await expectRejected(
      chat.id,
      'EARLIER_USER_0',
      [],
      {
        trigger: 'regenerate-message',
        messages: [
          { id: seeded[0]!.id, role: 'user', parts: [{ type: 'text', text: 'EARLIER_USER_0' }] },
        ],
      },
      { message: 'Only the latest reply can be retried' },
    );
    const before = await messages(chat.id);
    const started = await send(chat.id, 'Same prompt', {
      trigger: 'regenerate-message',
      messages: [{ id: target.id, role: 'user', parts: [{ type: 'text', text: 'Same prompt' }] }],
    });
    expect(started.turn.uiMessages.at(-1)?.id).toBe(target.id);
    expect(started.turn.promptMessageId).toBe(target.id);
    expect(started.turn.submittedMessageId).toBeNull();
    const text = await sdkText(started);
    expect(text).toContain('ORIGINAL_DOCUMENT_CONTENT');
    expect(text).toContain('EARLIER_ANSWER_79');
    expect(text).not.toContain('ORIGINAL_ANSWER_NOT_INPUT');
    expect(getBlob).not.toHaveBeenCalled();
    const after = await messages(chat.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, -2)).toEqual(before.slice(0, -1));
    expect(after.at(-2)).toEqual({
      ...before.at(-1),
      supersededAt: expect.any(Date),
      updatedAt: expect.any(Date),
      // Superseding is a change the compliance export records (migration 0034).
      changeSeq: expect.any(Number),
    });
    expect(after.at(-1)?.parentMessageId).toBe(target.id);
    expect(after.filter((row) => row.role === 'user')).toHaveLength(81);
  });

  it('caps serialized DB payload at 512 KiB, for both a single huge row and an aggregate huge turn', async () => {
    // Padding is metadata, not model text: only the DB payload ceiling can
    // exclude these otherwise-cheap turns. Older cheap rows must not be skipped to.
    const payloads = [
      [600 * 1024, 0],
      [310 * 1024, 210 * 1024],
    ] as const;
    for (const [userBytes, assistantBytes] of payloads) {
      const chat = await thread();
      const seeded = await seedHistory(chat.id, [
        { role: 'user', text: 'OLDER_CHEAP_USER' },
        { role: 'assistant', text: 'OLDER_CHEAP_REPLY' },
        { role: 'user', text: 'PAYLOAD_USER', padding: 'u'.repeat(userBytes) },
        { role: 'assistant', text: 'PAYLOAD_REPLY', padding: 'a'.repeat(assistantBytes) },
        { role: 'user', text: 'NEWEST_USER' },
        { role: 'assistant', text: 'NEWEST_REPLY' },
      ]);
      loadHistory.mockClear();
      const started = await send(chat.id, 'LATEST_REQUIRED');
      const loaded: Awaited<ReturnType<typeof contextHistory.loadContextHistory>> =
        await loadHistory.mock.results[0]!.value;
      expect(loaded.limited).toBe(true);
      expect(loaded.history.map((row) => row.id)).toEqual(seeded.slice(-3).map((row) => row.id));
      expect(Buffer.byteLength(JSON.stringify(loaded.history))).toBeLessThan(512 * 1024);
      expect(started.turn.uiMessages.slice(0, -1).map((message) => message.id)).toEqual(
        seeded.slice(-2).map((message) => message.id),
      );
      expect(await sdkText(started)).toBe('NEWEST_USER\nNEWEST_REPLY\nLATEST_REQUIRED');
      expect(started.turn.contextLimited).toBe(true);
      // Omission is model-only; the large stored metadata is not rewritten.
      expect((await messages(chat.id))[2]?.parts).toEqual(seeded[2]!.parts);
    }
  });

  it('rejects an assistant regeneration target, and a user target with oversized stored metadata', async () => {
    for (const invalid of ['assistant', 'payload'] as const) {
      const chat = await thread();
      const [target] = await seedHistory(chat.id, [
        {
          role: invalid === 'assistant' ? 'assistant' : 'user',
          text: 'Original',
          ...(invalid === 'payload' ? { padding: 'x'.repeat(513 * 1024) } : {}),
        },
      ]);
      await expectRejected(
        chat.id,
        'Original',
        [],
        {
          trigger: 'regenerate-message',
          messages: [{ id: target!.id, role: 'user', parts: [{ type: 'text', text: 'Original' }] }],
        },
        {
          message:
            invalid === 'assistant'
              ? 'target must be a user message'
              : 'target exceeds the input payload limit',
        },
      );
    }
  });
});
