import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
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
  MiB,
  png,
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
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * Bounded model context: turn preparation (setupTurn) through real PostgreSQL
 * and local blob storage, stopping before any provider call.
 *
 * This file: attached files and images, their limits and materialization.
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

  const { thread, attachment, seedHistory, send, expectRejected } = budgetHelpers({
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
});
