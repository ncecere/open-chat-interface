import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
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
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type * as attachmentContext from '../../services/chat/attachment-context.js';
import type * as contextHistory from '../../services/chat/context-history.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
type FileRow = typeof schema.attachment.$inferSelect;
type HistoryRow = {
  role: 'user' | 'assistant';
  text: string;
  files?: FileRow[];
  padding?: string;
};
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
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
);
const MiB = 1024 * 1024;

async function sdkMessages(started: StartedTurn) {
  return convertToModelMessages(started.turn.uiMessages);
}
async function sdkText(started: StartedTurn) {
  return (await sdkMessages(started))
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
}

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

  async function thread() {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: owner, organizationId: state.organizationId })
      .returning();
    return row!;
  }
  async function messages(threadId: string) {
    return pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
  }
  async function attachment(
    options: { image?: boolean; text?: string; sizeBytes?: number; missingBlob?: boolean } = {},
  ) {
    const bytes = options.image ? png : Buffer.from('uploaded document fixture');
    const mimeType = options.image ? 'image/png' : 'text/plain';
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: owner,
        filename: options.image ? 'pixel.png' : 'document.txt',
        mimeType,
        sizeBytes: options.sizeBytes ?? bytes.length,
        storageKey: randomUUID(),
        extractedText: options.image ? null : (options.text ?? 'DOCUMENT_CONTENT'),
      })
      .returning();
    if (!options.missingBlob) await driver.put(row!.storageKey, bytes, mimeType);
    return row!;
  }
  async function seedHistory(threadId: string, rows: HistoryRow[]) {
    const values = rows.map((row, position) => ({
      id: randomUUID(),
      userId: owner,
      threadId,
      role: row.role,
      position,
      status: 'complete' as const,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, position)),
      parts: [
        { type: 'text', text: row.text },
        ...(row.files ?? []).map((file) => ({
          type: 'data-attachment',
          data: {
            id: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            url: `/api/attachments/${file.id}/content`,
          },
        })),
        ...(row.padding ? [{ type: 'data-fixture', data: { padding: row.padding } }] : []),
      ],
    }));
    await pool.db.insert(schema.message).values(values);
    for (const [index, row] of rows.entries()) {
      for (const file of row.files ?? []) {
        await pool.db
          .update(schema.attachment)
          .set({ messageId: values[index]!.id })
          .where(eq(schema.attachment.id, file.id));
      }
    }
    return values;
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: owner, name: 'Budget Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'budget-test-model',
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
  async function expectRejected(
    threadId: string,
    text: string,
    files: FileRow[] = [],
    extra: Partial<SendMessageInput> = {},
    expected: { materialized?: boolean; blobReads?: number; message?: string } = {},
  ) {
    const before = await messages(threadId);
    const counts = {
      released: state.released,
      quotaReleased: state.quotaReleased,
      abandoned: state.abandoned,
      unregistered: state.unregistered,
    };
    const request = send(threadId, text, { attachmentIds: files.map((file) => file.id), ...extra });
    await expect(request).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    if (expected.message) await expect(request).rejects.toThrow(expected.message);
    // No prompt, failed assistant or provisional claim survives rejected preparation.
    expect(await messages(threadId)).toEqual(before);
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      expect(state[key], key).toBe(counts[key] + 1);
    }
    for (const file of files) {
      const [stored] = await pool.db
        .select({ messageId: schema.attachment.messageId, deletedAt: schema.attachment.deletedAt })
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(stored).toEqual({ messageId: null, deletedAt: null });
    }
    if (expected.materialized) expect(materialize).toHaveBeenCalledOnce();
    else expect(materialize).not.toHaveBeenCalled();
    expect(getBlob).toHaveBeenCalledTimes(expected.blobReads ?? 0);
  }

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

  it('never reads an omitted historical image, even when its blob is missing; reads only the selected PNG', async () => {
    state.contextWindow = 13_000;
    state.maxOutputTokens = 1000;
    const chat = await thread();
    const omitted = await attachment({ image: true, missingBlob: true });
    const selected = await attachment({ image: true });
    await seedHistory(chat.id, [
      { role: 'user', text: 'OMITTED_IMAGE', files: [omitted] },
      { role: 'assistant', text: 'OMITTED_REPLY' },
      { role: 'user', text: 'SELECTED_IMAGE', files: [selected] },
      { role: 'assistant', text: 'SELECTED_REPLY' },
    ]);
    const started = await send(chat.id, 'Use the newest picture');
    expect(started.turn.contextLimited).toBe(true);
    expect(await sdkText(started)).not.toContain('OMITTED');
    expect(materialize.mock.calls[0]![0].map((file) => file.id)).toEqual([selected.id]);
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob).toHaveBeenCalledWith(selected.storageKey);
    expect(getBlob).not.toHaveBeenCalledWith(omitted.storageKey);
    const binaries = (await sdkMessages(started)).flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image' || part.type === 'file')
        : [],
    );
    expect(binaries).toHaveLength(1);
    const part = binaries[0]!;
    expect(part.mediaType).toBe('image/png');
    const raw = part.type === 'image' ? part.image : part.data;
    const data =
      typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'url'
        ? raw.url
        : raw;
    const bytes =
      data instanceof Uint8Array
        ? Buffer.from(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(String(data).replace(/^data:[^,]*,/, ''), 'base64');
    expect(bytes).toEqual(png);
  });

  it('rejects a latest image over 20 MiB from metadata before opening its tiny fixture blob', async () => {
    state.contextWindow = 100_000;
    const chat = await thread();
    const file = await attachment({ image: true, sizeBytes: 20 * MiB + 1 });
    await expectRejected(chat.id, 'Describe this picture', [file]);
  });

  it('rejects aggregate image bytes over 20 MiB before reading either individually valid image', async () => {
    state.contextWindow = 100_000;
    const chat = await thread();
    const files = await Promise.all([
      attachment({ image: true, sizeBytes: 11 * MiB }),
      attachment({ image: true, sizeBytes: 10 * MiB }),
    ]);
    await expectRejected(chat.id, 'Compare the pictures', files);
  });

  it('rejects 33 context files even though storage policy permits 100 per message', async () => {
    state.contextWindow = 1_000_000;
    const chat = await thread();
    const files = await Promise.all(
      Array.from({ length: 33 }, (_, index) => attachment({ text: `small file ${index}` })),
    );
    await expectRejected(chat.id, 'Read these small files', files);
  });

  it('rejects huge extracted text from size metadata without materializing it or allocating the upload', async () => {
    state.contextWindow = 1_000_000;
    const chat = await thread();
    const file = await attachment({ text: '界'.repeat(200_000) });
    expect(file.sizeBytes).toBeLessThan(100);
    expect(Buffer.byteLength(file.extractedText!)).toBe(600_000);
    await expectRejected(chat.id, 'Read the extracted document', [file]);
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

  it('enforces the configured per-message file policy before materialization', async () => {
    state.maxFilesPerMessage = 1;
    const files = await Promise.all([attachment(), attachment()]);
    await expectRejected(
      (await thread()).id,
      'Too many uploads for this policy',
      files,
      {},
      {
        message: 'At most 1 files can be sent per message',
      },
    );
  });

  it('rejects reusing an already allocated incoming file before opening it', async () => {
    const source = await thread();
    const file = await attachment();
    const [original] = await seedHistory(source.id, [
      { role: 'user', text: 'Original', files: [file] },
    ]);
    await expectRejected(
      (await thread()).id,
      'Reuse',
      [],
      { attachmentIds: [file.id] },
      {
        message: 'Attachments must be available and not already sent',
      },
    );
    expect(
      (await pool.db.select().from(schema.attachment).where(eq(schema.attachment.id, file.id)))[0]
        ?.messageId,
    ).toBe(original!.id);
  });

  it('detects real metadata changes between inspection and materialization without allocating the upload', async () => {
    const file = await attachment();
    const module = await import('../../services/chat/attachment-context.js');
    const inspect = module.inspectIncomingAttachments;
    vi.spyOn(module, 'inspectIncomingAttachments').mockImplementation(async (...args) => {
      const candidates = await inspect(...args);
      await pool.db
        .update(schema.attachment)
        .set({ extractedText: 'Changed after size inspection' })
        .where(eq(schema.attachment.id, file.id));
      return candidates;
    });
    await expectRejected(
      (await thread()).id,
      'Read',
      [file],
      {},
      {
        materialized: true,
        message: 'Attachment context changed',
      },
    );
  });

  it('rejects a local blob whose actual size differs from its inspected metadata', async () => {
    const file = await attachment({ image: true, sizeBytes: png.length - 1 });
    await expectRejected(
      (await thread()).id,
      'Read',
      [file],
      {},
      {
        materialized: true,
        blobReads: 1,
        message: 'Attachment bytes exceed the model input limit',
      },
    );
  });

  it('guards standalone inspection/materialization helpers against oversized file lists too', async () => {
    const module = await import('../../services/chat/attachment-context.js');
    const ids = Array.from({ length: 33 }, () => randomUUID());
    await expect(module.inspectIncomingAttachments(ids, owner, 'user')).rejects.toThrow(
      'At most 32',
    );
    await expect(
      module.inspectHistoricalAttachments(
        [
          {
            id: 'stored',
            role: 'user',
            parts: ids.map((id) => ({ type: 'data-attachment', data: { id } })),
          },
        ],
        owner,
      ),
    ).rejects.toThrow('Too many historical context files');
    await expect(
      module.materializeAttachments(
        ids.map((id) => ({
          id,
          messageId: null,
          mimeType: 'text/plain',
          sizeBytes: 1,
          textBytes: 1,
          filenameBytes: 1,
          deletedAt: null,
        })),
        owner,
        'user',
        true,
      ),
    ).rejects.toThrow('Too many context files');
    expect(getBlob).not.toHaveBeenCalled();
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
