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
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import type { setupTurn } from '../../services/chat/setup-turn.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;
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
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  'base64',
);
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// Inspect the actual SDK model messages, not merely UI metadata that the SDK drops.
async function modelParts(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages.flatMap((message) =>
    message.role === 'user' && Array.isArray(message.content) ? message.content : [],
  );
}
async function modelText(started: StartedTurn) {
  return (await modelParts(started))
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}
async function imageBytes(started: StartedTurn) {
  const binaries = (await modelParts(started)).filter(
    (part) => part.type === 'image' || part.type === 'file',
  );
  expect(binaries).toHaveLength(1);
  const part = binaries[0]!;
  expect(part.mediaType).toBe('image/png');
  const raw = part.type === 'image' ? part.image : part.data;
  // This SDK represents files with a discriminated data envelope, including
  // data URLs; inspect that URL rather than base64-decoding '[object Object]'.
  const data =
    typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'url' ? raw.url : raw;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  expect(typeof data === 'string' || data instanceof URL).toBe(true);
  const encoded = String(data);
  expect(encoded).not.toMatch(/^https?:/);
  return Buffer.from(encoded.replace(/^data:[^,]*,/, ''), 'base64');
}

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
    mimeType = 'text/plain',
    extractedText: string | null = 'fixture text',
  ) {
    // Seed extraction results directly: this suite tests context, not PDF extraction/upload.
    const bytes = mimeType === 'image/png' ? png : Buffer.from(extractedText ?? 'fixture');
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: owner,
        filename:
          mimeType === 'image/png'
            ? 'pixel.png'
            : mimeType === 'application/pdf'
              ? 'report.pdf'
              : 'note.txt',
        mimeType,
        sizeBytes: bytes.length,
        storageKey: randomUUID(),
        extractedText,
      })
      .returning();
    await driver.put(row!.storageKey, bytes, mimeType);
    return row!;
  }
  async function send(
    threadId: string,
    text: string,
    extra: Partial<SendMessageInput> = {},
    role: 'user' | 'restricted' = 'user',
  ) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: owner, name: 'Test User', role },
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
  async function complete(started: StartedTurn) {
    await pool.db
      .update(schema.message)
      .set({ status: 'complete', parts: [{ type: 'text', text: 'Fixture reply' }] })
      .where(eq(schema.message.id, started.run.assistantMessage.id));
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    await releaseRunHandles(started.run, true);
    runs.delete(started.run);
  }
  async function assertFailedWithoutWrites(
    threadId: string,
    before: Awaited<ReturnType<typeof messages>>,
    released: number,
  ) {
    expect(await messages(threadId)).toEqual(before);
    expect(state.released).toBe(released + 1);
  }

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
    });
    expect(after.filter((row) => row.role === 'user')).toHaveLength(2);
    expect(after.at(-1)?.parentMessageId).toBe(second.turn.promptMessageId);
    expect(after.at(-1)?.supersededAt).toBeNull();
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

  it('allows parallel historical readers without waiting on their shared file lock', async () => {
    const chat = await thread();
    const file = await attachment();
    const first = await send(chat.id, 'Read file', { attachmentIds: [file.id] });
    await complete(first);
    const holder = await pool.sql.reserve();
    let finished = false;
    let pending: Promise<StartedTurn | Error> | undefined;
    try {
      await holder`begin`;
      await holder`select id from attachment where id = ${file.id} for share`;
      pending = send(chat.id, 'Concurrent reader').then(
        (result) => {
          finished = true;
          return result;
        },
        (error: Error) => {
          finished = true;
          return error;
        },
      );
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_000, interval: 10 });
      expect(await pending).not.toBeInstanceOf(Error);
    } finally {
      await holder`rollback`;
      holder.release();
      await pending;
    }
  });

  it('rejects a busy historical snapshot without deadlocking a hard-purge cascade', async () => {
    const source = await thread();
    const one = await attachment('image/png', null);
    const two = await attachment('image/png', null);
    const high = one.id > two.id ? one : two;
    const first = await send(source.id, 'Read files', { attachmentIds: [one.id, two.id] });
    await complete(first);
    const { forkFromMessage } = await import('../../services/threads.js');
    const fork = await forkFromMessage(source.id, owner, {
      messageId: first.run.assistantMessage.id,
    });
    const forkMessages = await messages(fork.id);
    const leaf = await forkFromMessage(fork.id, owner, { messageId: forkMessages.at(-1)!.id });
    const before = await messages(leaf.id);
    const released = state.released;
    const hydrated = gate();
    const finish = gate();
    let reads = 0;
    getBlob.mockImplementation(async (key) => {
      const bytes = await LocalStorageDriver.prototype.get.call(driver, key);
      if (++reads === 2) {
        hydrated.open();
        await finish.promise;
      }
      return bytes;
    });
    let finished = false;
    const pending = send(leaf.id, 'Must not persist').then(
      () => {
        finished = true;
        return null;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    const holder = await pool.sql.reserve();
    let purgeError: unknown;
    let error: unknown;
    try {
      await hydrated.promise;
      const { softDeleteThread } = await import('../../services/lifecycle/trash.js');
      await softDeleteThread(source.id, owner);
      await holder`begin`;
      await holder`set local statement_timeout = '5s'`;
      const [session] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from attachment where id = ${high.id} for update`;
      finish.open();
      // Observe either the new fail-fast result or the old real lock wait.
      await vi.waitFor(
        async () => {
          const blocked =
            await pool.sql`select pid from pg_stat_activity where datname = current_database()
          and ${session!.pid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`;
          expect(finished || blocked.length > 0).toBe(true);
        },
        { timeout: 2_000, interval: 10 },
      );
      try {
        // The same DELETE as the public purge, on the session holding HIGH.
        // An old waiter holding LOW cycles with this real FK cascade.
        await holder`delete from thread where id = ${source.id} and user_id = ${owner} and deleted_at is not null`;
        await holder`commit`;
      } catch (error) {
        purgeError = error;
      }
    } finally {
      finish.open();
      await holder`rollback`;
      holder.release();
      error = await pending;
    }
    expect(purgeError).toBeUndefined();
    expect(error).toMatchObject({ status: 422 });
    await assertFailedWithoutWrites(leaf.id, before, released);
  }, 20_000);

  it('revalidates historical files at persistence after deletion races with hydration', async () => {
    const chat = await thread();
    const file = await attachment('image/png', null);
    const first = await send(chat.id, 'Read image', { attachmentIds: [file.id] });
    await complete(first);
    const before = await messages(chat.id);
    const released = state.released;
    const newUpload = await attachment('text/plain', 'New upload must remain unallocated');
    const hydrated = gate();
    const finish = gate();
    getBlob.mockImplementation(async (key) => {
      const bytes = await LocalStorageDriver.prototype.get.call(driver, key);
      if (key === file.storageKey) {
        hydrated.open();
        await finish.promise;
      }
      return bytes;
    });
    // Observe rejection immediately so the gated request cannot become unhandled.
    const pending = send(chat.id, 'RACING_PROMPT_MUST_NOT_BE_STORED', {
      attachmentIds: [newUpload.id],
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    try {
      await hydrated.promise;
      await pool.db
        .update(schema.attachment)
        .set({ deletedAt: new Date() })
        .where(eq(schema.attachment.id, file.id));
    } finally {
      finish.open();
    }
    const result = await pending;
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    await assertFailedWithoutWrites(chat.id, before, released);
    const [unallocated] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, newUpload.id));
    expect(unallocated?.messageId).toBeNull();
    state.hook = null;
    const retry = await send(chat.id, 'Retry after deletion');
    expect(await modelText(retry)).toMatch(/unavailable|no longer available/i);
  });
});
