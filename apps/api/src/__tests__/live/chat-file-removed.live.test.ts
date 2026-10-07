import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachmentHelpers,
  modelText,
  shareFilesWithSource,
} from '../../../test/chat-attachment-context.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * A file that is gone is shown and told as gone (#359). It stayed a normal
 * chip with a dead link, and the model, given only a generic line, answered as
 * if it had read the file (it invented figures from a PDF it no longer had).
 * The conversation the page reads now marks such a file `available: false`
 * (what the chip draws as "No longer available"), and the model is told by
 * name that the file cannot be read and must not be guessed at. Real chat
 * routes and turn preparation (stopping before any provider call) on real
 * PostgreSQL and local storage.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as LocalStorageDriver | null,
  released: 0,
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
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: true, temporaryChat: true, branching: true };
    if (key === 'storage') return { maxFilesPerMessage: 10 };
    if (key === 'roleFeatures') return {};
    throw new Error(`Unexpected setting: ${key}`);
  },
}));
vi.mock('../../services/storage/index.js', () => ({
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
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
  cancelActiveChatRun: async () => false,
  resumeActiveChatRun: async () => null,
}));

const available = await livePostgresAvailable();

interface Wire {
  id: string;
  role: string;
  parts: Array<{ type: string; data?: { id: string; filename: string; available?: boolean } }>;
}

describe.skipIf(!available)('live: a removed file is shown and told as removed (#359)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let owner: string;
  let driver: LocalStorageDriver;
  let app: Hono<AppBindings>;
  const runs = new Set<AcquiredRun>();

  beforeAll(async () => {
    live = await createLiveDatabase('file_removed');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    root = await mkdtemp(join(tmpdir(), 'oci-file-removed-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
    const { chatRoutes } = await import('../../routes/chat.js');
    const { threadRoutes } = await import('../../routes/threads.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: owner,
        name: 'Test',
        email: 'test@example.test',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/chat', chatRoutes);
    app.route('/api/threads', threadRoutes);
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

  const { thread, attachment, send, complete } = attachmentHelpers({
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

  /** A conversation whose first question was sent with a PDF and a note. */
  async function answered() {
    const chat = await thread();
    const pdf = await attachment('application/pdf', 'PDF_CONTENT_650_DOLLARS');
    const note = await attachment('text/plain', 'NOTE_CONTENT');
    const first = await send(chat.id, 'Read the files', { attachmentIds: [pdf.id, note.id] });
    await complete(first);
    return { chat, pdf, note };
  }

  /** A fork made at the reply to the conversation's first question. */
  async function forkAtReply(threadId: string) {
    const rows = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, threadId))
      .orderBy(schema.message.position);
    const reply = rows.find((row) => row.role === 'assistant')!;
    const { forkFromMessage } = await import('../../services/threads.js');
    return forkFromMessage(threadId, owner, { messageId: reply.id });
  }

  async function read(path: string) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    return (await response.json()) as { messages: Wire[]; replies: Wire[] };
  }
  const chips = (messages: Wire[]) =>
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === 'data-attachment'
          ? [{ id: part.data!.id, filename: part.data!.filename, available: part.data!.available }]
          : [],
      ),
    );

  it('marks only the files that cannot be opened, whole and in pages', async () => {
    const { chat, pdf, note } = await answered();
    expect(chips((await read(`/api/chat/${chat.id}/messages`)).messages)).toEqual([
      { id: pdf.id, filename: 'report.pdf', available: undefined },
      { id: note.id, filename: 'note.txt', available: undefined },
    ]);
    // The PDF's row is gone (as after a purge); the note's file was deleted in Settings.
    await pool.db.delete(schema.attachment).where(eq(schema.attachment.id, pdf.id));
    await pool.db
      .update(schema.attachment)
      .set({ deletedAt: new Date(), deletedReason: 'user' })
      .where(eq(schema.attachment.id, note.id));
    const expected = [
      { id: pdf.id, filename: 'report.pdf', available: false },
      { id: note.id, filename: 'note.txt', available: false },
    ];
    expect(chips((await read(`/api/chat/${chat.id}/messages`)).messages)).toEqual(expected);
    expect(chips((await read(`/api/chat/${chat.id}/messages?limit=5`)).messages)).toEqual(expected);
    const stored = await app.request(`/api/threads/${chat.id}`);
    expect(
      ((await stored.json()) as { messages: Array<{ parts: Wire['parts'] }> }).messages.flatMap(
        (message) =>
          message.parts
            .filter((part) => part.type === 'data-attachment')
            .map((p) => p.data!.available),
      ),
    ).toEqual([false, false]);
    // Reading never changes what is stored.
    const [question] = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, chat.id))
      .orderBy(schema.message.position);
    expect(JSON.stringify(question!.parts)).not.toContain('"available"');
  });

  it('marks nothing when the files of a fork or an edit outlive their original', async () => {
    const { chat, pdf } = await answered();
    const fork = await forkAtReply(chat.id);
    const { destroyThreads } = await import('../../services/lifecycle/destroy.js');
    await destroyThreads(eq(schema.thread.id, chat.id), { reason: 'user', actorUserId: owner });
    expect(
      await pool.db.select().from(schema.attachment).where(eq(schema.attachment.id, pdf.id)),
    ).toHaveLength(0);
    expect(chips((await read(`/api/chat/${fork.id}/messages`)).messages)).toEqual([
      { id: expect.not.stringMatching(pdf.id), filename: 'report.pdf', available: undefined },
      { id: expect.any(String), filename: 'note.txt', available: undefined },
    ]);
  });

  it('marks the files of a fork made before 0.11 once its source is gone', async () => {
    const { chat } = await answered();
    const fork = await forkAtReply(chat.id);
    await shareFilesWithSource(pool, fork.id);
    expect(
      chips((await read(`/api/chat/${fork.id}/messages`)).messages).map((chip) => chip.available),
    ).toEqual([undefined, undefined]);
    await pool.db
      .update(schema.thread)
      .set({ deletedAt: new Date() })
      .where(eq(schema.thread.id, chat.id));
    expect(
      chips((await read(`/api/chat/${fork.id}/messages`)).messages).map((chip) => chip.available),
    ).toEqual([false, false]);
  });

  it('tells the model, by name, which files are gone and not to guess at them', async () => {
    const { chat, pdf, note } = await answered();
    await pool.db.delete(schema.attachment).where(eq(schema.attachment.id, pdf.id));
    const followup = await send(chat.id, 'Look at the PDF again: what is the exact cost?');
    const text = await modelText(followup);
    // The file's name comes from the stored part: its row is gone.
    expect(text).toContain('The file "report.pdf" attached to this message is no longer available');
    expect(text).toMatch(/Do not guess or make up what it contained/);
    expect(text).toContain('tell the person the file is unavailable');
    // What can still be read is still sent, and what cannot is not.
    expect(text).toContain('NOTE_CONTENT');
    expect(text).not.toContain('PDF_CONTENT_650_DOLLARS');
    expect(note.filename).toBe('note.txt');
  });

  it('names a file removed in Settings from its row, and says several files at once', async () => {
    const { chat, pdf, note } = await answered();
    await pool.db
      .update(schema.attachment)
      .set({ deletedAt: new Date(), deletedReason: 'user' })
      .where(eq(schema.attachment.id, pdf.id));
    await pool.db.delete(schema.attachment).where(eq(schema.attachment.id, note.id));
    const text = await modelText(await send(chat.id, 'And now?'));
    expect(text).toContain(
      'The files "report.pdf", "note.txt" attached to this message are no longer available',
    );
    expect(text).toContain('tell the person the files are unavailable');
    expect(text).not.toContain('NOTE_CONTENT');
    expect(text).not.toContain('PDF_CONTENT_650_DOLLARS');
  });
});
