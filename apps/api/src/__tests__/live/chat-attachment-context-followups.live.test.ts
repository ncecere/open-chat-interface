import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
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
  attachmentHelpers,
  imageBytes,
  modelParts,
  modelText,
  png,
} from '../../../test/chat-attachment-context.fixtures.js';
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
 * Historical attachment context: turn preparation (setupTurn) with files from
 * earlier turns, through real PostgreSQL and local blob storage, stopping
 * before any provider call.
 *
 * This file: files carried into follow-ups and retries, and current policy.
 * The shared helpers are in test/chat-attachment-context.fixtures.ts; the
 * other chat-attachment-context-*.live.test.ts files cover the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  vision: true,
  attachments: true,
  released: 0,
  hook: null as (() => Promise<void>) | null,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// Only environmental/policy dependencies are stubbed. Attachment loading,
// admission claims, preparation, persistence, SDK conversion and blob I/O are real.
// setupTurn stops before provider invocation; no inference requests are made.
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: state.vision ? ['vision'] : [],
    supportedEfforts: [],
    providerKind: 'openai',
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: state.attachments, temporaryChat: true };
    if (key === 'storage') return { maxFilesPerMessage: 10 };
    // No saved role overrides: built-in role defaults apply.
    if (key === 'roleFeatures') return {};
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => {
    await state.hook?.();
    return '';
  },
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({
    release: async () => {
      state.released++;
    },
  }),
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

describe.skipIf(!available)('live historical attachment context', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let driver: LocalStorageDriver;
  let getBlob: MockInstance<LocalStorageDriver['get']>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('attachment_context');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-attachment-context-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
  });
  beforeEach(() => {
    state.vision = true;
    state.attachments = true;
    state.released = 0;
    state.hook = null;
    getBlob = vi.spyOn(driver, 'get');
  });
  afterEach(async () => {
    state.hook = null;
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const { thread, messages, attachment, send, complete, assertFailedWithoutWrites } =
    attachmentHelpers({
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
      state,
    });

  it.each(['text/plain', 'application/pdf'])(
    'retains extracted %s on a follow-up without rewriting history',
    async (mimeType) => {
      const chat = await thread();
      const file = await attachment(mimeType, 'The project codename is Silver Birch.');
      const first = await send(chat.id, 'Read this file', { attachmentIds: [file.id] });
      expect(await modelText(first)).toContain(file.extractedText);
      await complete(first);
      const before = await messages(chat.id);
      getBlob.mockClear();

      const followup = await send(chat.id, 'What is the codename?');
      expect(await modelText(followup)).toContain('Silver Birch');
      expect(await modelText(followup)).toContain(file.filename);
      expect(getBlob).not.toHaveBeenCalled();
      expect((await messages(chat.id)).slice(0, 2)).toEqual(before);
      expect(JSON.stringify(before[0]!.parts)).not.toContain('Silver Birch');
      expect(before[0]!.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'data-attachment',
            data: expect.objectContaining({ id: file.id }),
          }),
        ]),
      );
    },
  );

  it('passes canonical historical image bytes through the real SDK conversion', async () => {
    const chat = await thread();
    const file = await attachment('image/png', null);
    const first = await send(chat.id, 'Describe the image', { attachmentIds: [file.id] });
    expect(await imageBytes(first)).toEqual(png);
    await complete(first);
    getBlob.mockClear();
    const followup = await send(chat.id, 'What color is it?');
    expect(await imageBytes(followup)).toEqual(png);
    expect(getBlob).toHaveBeenCalledWith(file.storageKey);
    const sdk = JSON.stringify(await convertToModelMessages(followup.turn.uiMessages));
    expect(sdk).not.toContain(`/api/attachments/${file.id}/content`);
  });

  it('regenerates only the latest stored target, with its file and history but not the replaced reply', async () => {
    const chat = await thread();
    const early = await attachment('text/plain', 'EARLY_ATTACHMENT_CONTENT');
    const late = await attachment('application/pdf', 'LATEST_ATTACHMENT_CONTENT');
    const first = await send(chat.id, 'Same prompt', { attachmentIds: [early.id] });
    await complete(first);
    const second = await send(chat.id, 'Same prompt', { attachmentIds: [late.id] });
    await complete(second);
    const before = await messages(chat.id);
    const regenerate = (promptId: string) =>
      send(chat.id, 'Same prompt', {
        trigger: 'regenerate-message',
        messages: [{ id: promptId, role: 'user', parts: [{ type: 'text', text: 'Same prompt' }] }],
      });
    // An earlier turn is fixed: the later turn answered it as it stands.
    await expect(regenerate(first.turn.promptMessageId)).rejects.toThrow(
      'Only the latest reply can be retried',
    );
    expect(await messages(chat.id)).toEqual(before);

    const regenerated = await regenerate(second.turn.promptMessageId);
    expect(await modelText(regenerated)).toContain('LATEST_ATTACHMENT_CONTENT');
    expect(await modelText(regenerated)).toContain('EARLY_ATTACHMENT_CONTENT');
    expect(regenerated.turn.uiMessages.map((message) => message.id)).toEqual([
      first.turn.promptMessageId,
      first.run.assistantMessage.id,
      second.turn.promptMessageId,
    ]);
    expect(regenerated.turn.submittedMessageId).toBeNull();
    const after = await messages(chat.id);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    // The replaced reply is kept for switching back, only superseded.
    expect(after[3]).toEqual({
      ...before[3],
      supersededAt: expect.any(Date),
      updatedAt: expect.any(Date),
      // Superseding is a change the compliance export records (migration 0034).
      changeSeq: expect.any(Number),
    });
    expect(after.filter((row) => row.role === 'user')).toHaveLength(2);
    expect(after.at(-1)?.parentMessageId).toBe(second.turn.promptMessageId);
    expect(after.at(-1)?.supersededAt).toBeNull();
  });

  it('ignores arbitrary stored file URLs and trusts canonical attachment metadata instead', async () => {
    const chat = await thread();
    const file = await attachment('text/plain', 'CANONICAL_TEXT');
    const first = await send(chat.id, 'Read this', { attachmentIds: [file.id] });
    await complete(first);
    await pool.db
      .update(schema.message)
      .set({
        parts: [
          { type: 'text', text: 'Read this' },
          { type: 'file', mediaType: 'image/png', url: 'https://invalid.example/arbitrary-file' },
          {
            type: 'data-attachment',
            data: {
              id: file.id,
              filename: 'FORGED_FILENAME',
              mimeType: 'image/png',
              url: 'https://invalid.example/forged-metadata',
            },
          },
        ],
      })
      .where(eq(schema.message.id, first.turn.promptMessageId));
    getBlob.mockClear();
    const followup = await send(chat.id, 'Continue');
    expect(await modelText(followup)).toContain('CANONICAL_TEXT');
    expect(await modelText(followup)).toContain(file.filename);
    const sdk = JSON.stringify(await convertToModelMessages(followup.turn.uiMessages));
    expect(sdk).not.toContain('invalid.example');
    expect(sdk).not.toContain('FORGED_FILENAME');
    expect(getBlob).not.toHaveBeenCalled();
    expect((await modelParts(followup)).every((part) => part.type === 'text')).toBe(true);
  });

  it('does not read new or historical image blobs for a non-vision model', async () => {
    state.vision = false;
    const chat = await thread();
    const file = await attachment('image/png', null);
    await driver.delete(file.storageKey);
    const first = await send(chat.id, 'Read image', { attachmentIds: [file.id] });
    expect(await modelText(first)).toMatch(/could not be read|unreadable/i);
    await complete(first);
    const followup = await send(chat.id, 'Continue');
    expect(await modelText(followup)).toMatch(/could not be read|unreadable/i);
    expect((await modelParts(followup)).every((part) => part.type === 'text')).toBe(true);
    expect(getBlob).not.toHaveBeenCalled();
  });

  it('releases the claim on a missing historical image without persisting the new prompt', async () => {
    const chat = await thread();
    const file = await attachment('image/png', null);
    const first = await send(chat.id, 'Read image', { attachmentIds: [file.id] });
    await complete(first);
    const before = await messages(chat.id);
    const released = state.released;
    await driver.delete(file.storageKey);
    await expect(send(chat.id, 'MUST_NOT_BE_STORED')).rejects.toThrow(/missing.*storage/i);
    await assertFailedWithoutWrites(chat.id, before, released);
    await driver.put(file.storageKey, png, 'image/png');
    expect(await imageBytes(await send(chat.id, 'Retry after restoration'))).toEqual(png);
  });

  it('enforces current feature and role policy on historical files and cleans up both failed claims', async () => {
    const chat = await thread();
    const file = await attachment();
    const first = await send(chat.id, 'Read file', { attachmentIds: [file.id] });
    await complete(first);
    const before = await messages(chat.id);
    let released = state.released;
    state.attachments = false;
    await expect(send(chat.id, 'Disabled feature')).rejects.toThrow(/disabled/i);
    await assertFailedWithoutWrites(chat.id, before, released);
    state.attachments = true;
    released = state.released;
    await expect(send(chat.id, 'Restricted role', {}, 'restricted')).rejects.toThrow(
      /attachments are not available for your role/i,
    );
    await assertFailedWithoutWrites(chat.id, before, released);
    expect(await modelText(await send(chat.id, 'Allowed again'))).toContain('fixture text');
  });
});
