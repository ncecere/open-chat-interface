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
  gate,
  modelParts,
  modelText,
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
 * This file: forked conversations and references that are no longer valid.
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
  let stranger: string;
  let driver: LocalStorageDriver;
  let getBlob: MockInstance<LocalStorageDriver['get']>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('attachment_context');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
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

  it('resolves copied fork metadata against the original live owned allocation', async () => {
    const source = await thread();
    const file = await attachment('text/plain', 'FORK_SOURCE_CONTENT');
    const first = await send(source.id, 'Read the source', { attachmentIds: [file.id] });
    await complete(first);
    const { forkFromMessage } = await import('../../services/threads.js');
    const fork = await forkFromMessage(source.id, owner, {
      messageId: first.run.assistantMessage.id,
    });
    const copied = (await messages(fork.id))[0]!;
    expect(copied.id).not.toBe(first.turn.promptMessageId);
    expect(JSON.stringify(copied.parts)).toContain(file.id);
    const followup = await send(fork.id, 'Use the copied file');
    expect(await modelText(followup)).toContain('FORK_SOURCE_CONTENT');
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, file.id));
    expect(stored?.messageId).toBe(first.turn.promptMessageId);
  });

  it.each(['deleted', 'expired'] as const)(
    'omits files from a %s source even when the copied fork and file stay live',
    async (kind) => {
      const source = await thread();
      const file = await attachment('text/plain', 'UNAVAILABLE_SOURCE_CONTENT');
      const first = await send(source.id, 'Read source', { attachmentIds: [file.id] });
      await complete(first);
      const { forkFromMessage } = await import('../../services/threads.js');
      const fork = await forkFromMessage(source.id, owner, {
        messageId: first.run.assistantMessage.id,
      });
      await pool.db
        .update(schema.thread)
        .set(
          kind === 'deleted'
            ? { deletedAt: new Date() }
            : { temporary: true, expiresAt: new Date(Date.now() - 1_000) },
        )
        .where(eq(schema.thread.id, source.id));
      const followup = await send(fork.id, 'Continue');
      expect(await modelText(followup)).not.toContain('UNAVAILABLE_SOURCE_CONTENT');
      expect(await modelText(followup)).toMatch(/unavailable|no longer available/i);
      expect(getBlob).not.toHaveBeenCalled();
    },
  );

  it.each(['deleted', 'expired'] as const)(
    'rechecks a source becoming %s after image hydration before committing the fork turn',
    async (kind) => {
      const source = await thread();
      const file = await attachment('image/png', null);
      const first = await send(source.id, 'Read source', { attachmentIds: [file.id] });
      await complete(first);
      const { forkFromMessage } = await import('../../services/threads.js');
      const fork = await forkFromMessage(source.id, owner, {
        messageId: first.run.assistantMessage.id,
      });
      const before = await messages(fork.id);
      const released = state.released;
      const hydrated = gate();
      const finish = gate();
      getBlob.mockImplementation(async (key) => {
        const bytes = await LocalStorageDriver.prototype.get.call(driver, key);
        hydrated.open();
        await finish.promise;
        return bytes;
      });
      const pending = send(fork.id, 'Must not persist').then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await hydrated.promise;
        await pool.db
          .update(schema.thread)
          .set(
            kind === 'deleted'
              ? { deletedAt: new Date() }
              : { temporary: true, expiresAt: new Date(Date.now() - 1_000) },
          )
          .where(eq(schema.thread.id, source.id));
      } finally {
        finish.open();
      }
      expect(await pending).toBeInstanceOf(Error);
      await assertFailedWithoutWrites(fork.id, before, released);
    },
  );

  it.each(['foreign', 'unallocated', 'pending', 'deleted'] as const)(
    'omits a %s reference with a generic notice and never reads its blob',
    async (kind) => {
      const chat = await thread();
      const file = await attachment('image/png', null);
      const [historical] = await pool.db
        .insert(schema.message)
        .values({
          threadId: chat.id,
          userId: owner,
          role: 'user',
          position: 0,
          parts: [
            { type: 'text', text: 'Earlier prompt' },
            {
              type: 'data-attachment',
              data: {
                id: file.id,
                filename: 'UNTRUSTED_SECRET_NAME',
                mimeType: 'image/png',
                url: 'https://invalid.example/secret-image',
              },
            },
          ],
        })
        .returning();
      await pool.db
        .update(schema.attachment)
        .set({
          messageId: kind === 'unallocated' ? null : historical!.id,
          userId: kind === 'foreign' ? stranger : owner,
          uploadPending: kind === 'pending',
          deletedAt: kind === 'deleted' ? new Date() : null,
        })
        .where(eq(schema.attachment.id, file.id));
      const followup = await send(chat.id, 'Continue');
      expect(getBlob).not.toHaveBeenCalled();
      expect((await modelParts(followup)).every((part) => part.type === 'text')).toBe(true);
      expect(await modelText(followup)).toMatch(/unavailable|no longer available/i);
      const sdk = JSON.stringify(await convertToModelMessages(followup.turn.uiMessages));
      expect(sdk).not.toContain('UNTRUSTED_SECRET_NAME');
      expect(sdk).not.toContain('https://invalid.example');
    },
  );
});
