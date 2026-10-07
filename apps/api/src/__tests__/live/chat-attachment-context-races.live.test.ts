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
  attachmentHelpers,
  gate,
  modelText,
  type StartedTurn,
  shareFilesWithSource,
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
 * This file: concurrent readers, purges and deletions during hydration.
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
    // Made before 0.11: the fork and its fork show the source's files (#358).
    await shareFilesWithSource(pool, fork.id);
    const forkMessages = await messages(fork.id);
    const leaf = await forkFromMessage(fork.id, owner, { messageId: forkMessages.at(-1)!.id });
    await shareFilesWithSource(pool, leaf.id);
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
