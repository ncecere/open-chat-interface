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
 * A file its owner deletes stays in the conversation, marked removed (#378).
 * Deleting it in Settings filtered the `data-attachment` part out of the
 * stored message, so the chip vanished without a trace and the model, told
 * nothing, answered "look at the PDF again" from imagination (#359 marks and
 * announces a part whose file cannot be opened, but the part was gone). Real
 * routes (the delete, the conversation reads, the export), real turn
 * preparation (stopping before any provider call), real PostgreSQL and local
 * storage.
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
    return {};
  },
}));
vi.mock('../../services/limits/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/limits/rate-limit.js')>()),
  consumeRateLimit: async () => ({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 1 }),
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

interface Part {
  type: string;
  data?: {
    id: string;
    filename: string;
    mimeType?: string;
    sizeBytes?: number;
    available?: boolean;
    removed?: boolean;
  };
}
interface Wire {
  id: string;
  role: string;
  parts: Part[];
}

describe.skipIf(!available)(
  'live: a file deleted by its owner stays, marked removed (#378)',
  () => {
    let live: LiveDatabase;
    let pool: ReturnType<typeof createDatabase>;
    let root: string;
    let owner: string;
    let driver: LocalStorageDriver;
    let app: Hono<AppBindings>;
    const runs = new Set<AcquiredRun>();

    beforeAll(async () => {
      live = await createLiveDatabase('file_deleted_kept');
      pool = createDatabase(live.connectionString, { max: 8 });
      state.db = pool.db;
      state.organizationId = await seedOrganization(pool.db);
      owner = await seedUser(pool.db, state.organizationId);
      root = await mkdtemp(join(tmpdir(), 'oci-file-deleted-'));
      driver = new LocalStorageDriver(root);
      state.driver = driver;
      const { chatRoutes } = await import('../../routes/chat.js');
      const { threadRoutes } = await import('../../routes/threads.js');
      const { attachmentRoutes } = await import('../../routes/attachments.js');
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
      app.route('/api/attachments', attachmentRoutes);
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

    /** A conversation whose first question was sent with a PDF. */
    async function answered() {
      const chat = await thread();
      const pdf = await attachment('application/pdf', 'PDF_SAYS_THE_PROJECT_STARTS_IN_MARCH_2027');
      const first = await send(chat.id, 'Read the file', { attachmentIds: [pdf.id] });
      await complete(first);
      return { chat, pdf };
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

    /** Settings → Attachments → Delete: the real route. */
    async function deleteInSettings(id: string) {
      const response = await app.request(`/api/attachments/${id}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
    }

    async function read(path: string) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      return (await response.json()) as { messages: Wire[] };
    }
    const fileParts = (messages: Wire[]) =>
      messages.flatMap((message) =>
        message.parts.filter((part) => part.type === 'data-attachment'),
      );
    const storedParts = async (threadId: string) =>
      (
        await pool.db
          .select()
          .from(schema.message)
          .where(eq(schema.message.threadId, threadId))
          .orderBy(schema.message.position)
      ).flatMap((message) =>
        (message.parts as unknown as Part[]).filter((part) => part.type === 'data-attachment'),
      );

    it('keeps the file in the conversation, marked removed, with its name, type and size', async () => {
      const { chat, pdf } = await answered();
      await deleteInSettings(pdf.id);
      for (const path of [
        `/api/chat/${chat.id}/messages`,
        `/api/chat/${chat.id}/messages?limit=5`,
        `/api/threads/${chat.id}`,
      ]) {
        expect(fileParts((await read(path)).messages).map((part) => part.data)).toEqual([
          expect.objectContaining({
            id: pdf.id,
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.sizeBytes,
            available: false,
            removed: true,
          }),
        ]);
      }
      // Stored with the message, so it survives the trash purging the row.
      expect(await storedParts(chat.id)).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: pdf.id, removed: true, sizeBytes: pdf.sizeBytes }),
        }),
      ]);
    });

    it('tells the model by name on every later turn, also once the row is purged', async () => {
      const { chat, pdf } = await answered();
      await deleteInSettings(pdf.id);
      const notice = 'The file "report.pdf" attached to this message is no longer available';
      const firstTurn = await send(
        chat.id,
        'Look at the PDF once more: what month does the project start?',
      );
      const first = await modelText(firstTurn);
      await complete(firstTurn);
      expect(first).toContain(notice);
      expect(first).toContain('tell the person the file is unavailable');
      expect(first).not.toContain('PDF_SAYS_THE_PROJECT_STARTS_IN_MARCH_2027');
      // The trash purges the row (and its object) later: the part is enough.
      await pool.db.delete(schema.attachment).where(eq(schema.attachment.id, pdf.id));
      const second = await modelText(await send(chat.id, 'And again?'));
      expect(second).toContain(notice);
      expect(
        fileParts((await read(`/api/chat/${chat.id}/messages`)).messages).map(
          (part) => part.data?.available,
        ),
      ).toEqual([false]);
    });

    it("marks only the conversation whose copy is deleted: a fork's copy is its own row", async () => {
      const { chat, pdf } = await answered();
      const fork = await forkAtReply(chat.id);
      const [copy] = await pool.db
        .select()
        .from(schema.attachment)
        .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
        .where(eq(schema.message.threadId, fork.id));
      expect(copy!.attachment.id).not.toBe(pdf.id);

      await deleteInSettings(pdf.id);
      expect((await storedParts(chat.id))[0]!.data!.removed).toBe(true);
      expect((await storedParts(fork.id))[0]!.data!.removed).toBeUndefined();
      expect(
        fileParts((await read(`/api/chat/${fork.id}/messages`)).messages).map(
          (part) => part.data?.available,
        ),
      ).toEqual([undefined]);
      const forkText = await modelText(await send(fork.id, 'Look at the file again'));
      expect(forkText).toContain('PDF_SAYS_THE_PROJECT_STARTS_IN_MARCH_2027');
      expect(forkText).not.toContain('no longer available');

      // And the other way round: deleting the fork's copy leaves the original's own file.
      const second = await answered();
      const secondFork = await forkAtReply(second.chat.id);
      const [secondCopy] = await pool.db
        .select({ id: schema.attachment.id })
        .from(schema.attachment)
        .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
        .where(eq(schema.message.threadId, secondFork.id));
      await deleteInSettings(secondCopy!.id);
      expect((await storedParts(secondFork.id))[0]!.data!.removed).toBe(true);
      expect((await storedParts(second.chat.id))[0]!.data!.removed).toBeUndefined();
    });

    it('marks only the owner when a fork made before 0.11 still shares the file', async () => {
      const { chat, pdf } = await answered();
      const fork = await forkAtReply(chat.id);
      await shareFilesWithSource(pool, fork.id);
      await deleteInSettings(pdf.id);
      expect((await storedParts(chat.id))[0]!.data!.removed).toBe(true);
      expect((await storedParts(fork.id))[0]!.data!.removed).toBeUndefined();
      expect(
        fileParts((await read(`/api/chat/${fork.id}/messages`)).messages).map(
          (part) => part.data?.available,
        ),
      ).toEqual([undefined]);
    });

    it('just removes a file that was never sent, as the composer × does', async () => {
      const chat = await thread();
      const draft = await attachment('text/plain', 'DRAFT');
      const unsent = await attachment('text/plain', 'DRAFT_TWO');
      await deleteInSettings(draft.id);
      const discarded = await app.request(`/api/attachments/${unsent.id}/unsent`, {
        method: 'DELETE',
      });
      expect(await discarded.json()).toEqual({ removed: true });
      const rows = await pool.db
        .select({ id: schema.attachment.id, deletedAt: schema.attachment.deletedAt })
        .from(schema.attachment)
        .where(sql`${schema.attachment.id} in (${draft.id}, ${unsent.id})`);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
      // Nothing was sent, so no message mentions either file.
      const sent = await send(chat.id, 'A question with no file');
      expect(await modelText(sent)).not.toContain('no longer available');
      expect(await storedParts(chat.id)).toEqual([]);
    });

    it('lists the file as removed in the exports and leaves it out of the share page', async () => {
      const { chat, pdf } = await answered();
      await deleteInSettings(pdf.id);
      const response = await app.request(`/api/threads/${chat.id}/export`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('_Attached: report.pdf (removed)_');
      // The full export carries the stored message, marked, beside an empty file list.
      const [question] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.threadId, chat.id))
        .orderBy(schema.message.position);
      const { exportableParts } = await import('../../services/export.js');
      expect(JSON.stringify(exportableParts(question!.parts))).toContain('"removed":true');
      // Shared conversations never carry file metadata, removed or not.
      const { sanitizePublicParts } = await import('../../services/share-links.js');
      expect(sanitizePublicParts(question!.parts).map((part) => part.type)).toEqual(['text']);
    });

    it('keeps a removed file in an edit box until it is removed there', async () => {
      const { chat, pdf } = await answered();
      await deleteInSettings(pdf.id);
      const { editedQuestionParts } = await import('../../services/chat/message-parts.js');
      const [question] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.threadId, chat.id))
        .orderBy(schema.message.position);
      const kept = editedQuestionParts(question!.parts, 'Edited', [pdf.id]);
      expect(kept).toHaveLength(2);
      expect((kept[1] as unknown as Part).data!.removed).toBe(true);
      expect(editedQuestionParts(question!.parts, 'Edited', [])).toHaveLength(1);
    });
  },
);
