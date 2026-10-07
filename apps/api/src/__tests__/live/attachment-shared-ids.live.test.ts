import { attachmentOwnRows, createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copiesHarness, defaultSettings } from '../../../test/attachment-copies.fixtures.js';
import { liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { resetReadinessCache } from '../../services/migrations/readiness.js';
import { S3StorageDriver } from '../../services/storage/s3-driver.js';

/**
 * Forks and edits made before each kept its own row for a file (#358) share
 * the original's attachment id. They must survive too: while the background
 * migration `0.11.attachment-own-rows` has not finished, every path that
 * deletes files first gives such a conversation its own row; the migration
 * converts the rest. The data is written as the previous release wrote it
 * (the same id in the copied message, no row of its own), the deletions are
 * the real services and routes, and the objects are in S3.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  driver: null as unknown,
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
}));
vi.mock('../../services/storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));

const available = (await livePostgresAvailable()) && (await liveS3Available());
const TEXT = 'The drainage trench costs $650 and the project starts in March 2027.';

describe.skipIf(!available)('live: forks and edits that already share a file (#358)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  const h = copiesHarness({
    get pool() {
      return pool;
    },
    state: state as never,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('attachment_shared_ids');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    state.driver = new S3StorageDriver(liveS3Config);
  });
  beforeEach(async () => {
    state.settings = defaultSettings();
    resetReadinessCache();
    await pool.db.execute(sql`delete from background_migration`);
    owner = await seedUser(pool.db, state.organizationId);
  });
  afterAll(async () => {
    await h.cleanup();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  type Conversation = Awaited<ReturnType<typeof h.conversation>>;

  /** A fork as the previous release made it: its messages carry the original's ids. */
  async function legacyCopy(
    original: Conversation,
    options: {
      edit?: boolean;
      from?: { threadId: string; questionId: string; replyId: string };
    } = {},
  ) {
    const source = options.from ?? {
      threadId: original.thread.id,
      questionId: original.question.id,
      replyId: original.reply.id,
    };
    const [chat] = await pool.db
      .insert(schema.thread)
      .values({
        userId: owner,
        organizationId: state.organizationId,
        title: options.edit ? 'Edited' : 'Fork of Grant questions',
        parentThreadId: source.threadId,
        branchedFromMessageId: options.edit ? source.questionId : source.replyId,
        lastMessageAt: new Date(),
      })
      .returning();
    const [question] = await pool.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, source.questionId));
    const [copiedQuestion] = await pool.db
      .insert(schema.message)
      .values({
        threadId: chat!.id,
        userId: owner,
        role: 'user',
        position: 0,
        parentMessageId: source.questionId,
        parts: options.edit
          ? [{ type: 'text', text: 'Edited?' }, ...question!.parts.slice(1)]
          : question!.parts,
      })
      .returning();
    if (!options.edit) {
      await pool.db.insert(schema.message).values({
        threadId: chat!.id,
        userId: owner,
        role: 'assistant',
        position: 1,
        parentMessageId: source.replyId,
        parts: [{ type: 'text', text: 'The trench costs $650.' }],
      });
    }
    return { threadId: chat!.id, questionId: copiedQuestion!.id, replyId: source.replyId };
  }

  const shownIds = async (threadId: string) =>
    (await pool.db.select().from(schema.message).where(eq(schema.message.threadId, threadId)))
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === 'data-attachment' ? [(part as { data: { id: string } }).data.id] : [],
      );

  /** What the person sees opening the copy: every file it shows, served or not. */
  async function shownFiles(threadId: string) {
    const ids = await shownIds(threadId);
    return Promise.all(ids.map(async (id) => ({ id, ...(await h.served(owner, id)) })));
  }

  const deletions: Array<{ path: string; run: (original: Conversation) => Promise<void> }> = [
    {
      path: 'trash, then Delete now',
      run: async (original) => {
        await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
        await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}/permanent`);
      },
    },
    {
      path: 'Empty trash',
      run: async (original) => {
        await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
        await h.call(owner, 'DELETE', '/api/threads/trash');
      },
    },
    {
      path: 'the automatic trash purge',
      run: async (original) => {
        await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
        await h.expireInTrash(original.thread.id);
        const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
        await purgeExpiredTrash();
      },
    },
    {
      path: 'deleting the file in Settings, then the trash purge',
      run: async (original) => {
        await h.call(owner, 'DELETE', `/api/attachments/${original.file.id}`);
        await pool.db.execute(sql`
          update attachment set deleted_at = now() - interval '30 days'
          where id = ${original.file.id}`);
        const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
        await purgeExpiredTrash();
      },
    },
  ];

  describe('before the background migration has run', () => {
    it.each(deletions)(
      'a fork and an edit keep their files when the original is deleted: $path',
      async ({ run }) => {
        const original = await h.conversation(owner, { text: TEXT });
        const fork = await legacyCopy(original);
        const edit = await legacyCopy(original, { edit: true });
        // As the previous release left them: the same id, the original's row.
        expect(await shownIds(fork.threadId)).toEqual([original.file.id]);
        expect(await h.filesOf(fork.threadId)).toHaveLength(0);

        await run(original);
        await h.drain();

        for (const copy of [fork, edit]) {
          const files = await shownFiles(copy.threadId);
          expect(files).toHaveLength(1);
          expect(files[0]).toMatchObject({ status: 200, text: TEXT });
          // Now its own row, in its own conversation.
          expect((await h.filesOf(copy.threadId)).map((file) => file.id)).toEqual([files[0]!.id]);
        }
        expect(await h.objectExists(original.file.storageKey)).toBe(true);
      },
    );

    it('follows a fork of a fork, whichever conversation is deleted first', async () => {
      const original = await h.conversation(owner, { text: TEXT });
      const first = await legacyCopy(original);
      const second = await legacyCopy(original, { from: first });
      // The middle conversation goes first, then the original: the last one
      // still opens its file.
      await h.call(owner, 'DELETE', `/api/threads/${first.threadId}`);
      await h.call(owner, 'DELETE', `/api/threads/${first.threadId}/permanent`);
      await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
      await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}/permanent`);
      await h.drain();
      const files = await shownFiles(second.threadId);
      expect(files[0]).toMatchObject({ status: 200, text: TEXT });
    });

    it('counts the rows it gives in the storage meter', async () => {
      const original = await h.conversation(owner, { text: TEXT });
      await legacyCopy(original);
      const before = await h.usage(owner);
      await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
      await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}/permanent`);
      await h.drain();
      // The original's row went; the fork's new row took its place.
      expect(await h.usage(owner)).toEqual({ ...before, pendingBytes: 0, pendingFiles: 0 });
    });
  });

  describe('the background migration', () => {
    async function runMigration() {
      let cursor: string | null = null;
      let copies = 0;
      for (;;) {
        const result = await pool.sql.begin(async (tx) => {
          const before = await tx<{ n: number }[]>`select count(*)::int as n from attachment`;
          const batch = await attachmentOwnRows.batch(tx, { cursor, batchSize: 2 });
          const after = await tx<{ n: number }[]>`select count(*)::int as n from attachment`;
          return { batch, made: after[0]!.n - before[0]!.n };
        });
        copies += result.made;
        cursor = result.batch.cursor;
        if (result.batch.done) return copies;
      }
    }

    it('gives forks and edits their own rows, rewrites their messages and counts the storage once', async () => {
      const original = await h.conversation(owner, { text: TEXT });
      const fork = await legacyCopy(original);
      const edit = await legacyCopy(original, { edit: true });
      const before = await h.usage(owner);

      expect(await runMigration()).toBe(2);
      for (const copy of [fork, edit]) {
        const [file] = await h.filesOf(copy.threadId);
        expect(file).toMatchObject({
          id: expect.not.stringMatching(original.file.id),
          storageKey: original.file.storageKey,
          extractedText: TEXT,
          userId: owner,
        });
        expect(await shownIds(copy.threadId)).toEqual([file!.id]);
        const [part] = (
          await pool.db.select().from(schema.message).where(eq(schema.message.id, copy.questionId))
        ).flatMap((message) => message.parts.filter((entry) => entry.type === 'data-attachment'));
        expect((part as { data: { url: string; filename: string } }).data).toMatchObject({
          url: `/api/attachments/${file!.id}/content`,
          filename: 'grant.txt',
        });
      }
      const size = original.file.sizeBytes;
      expect(await h.usage(owner)).toMatchObject({
        liveBytes: before.liveBytes + 2 * size,
        liveFiles: before.liveFiles + 2,
      });
      // Run again (a batch whose commit was lost to a failover): nothing more.
      expect(await runMigration()).toBe(0);

      // Now nothing is needed to delete the original (the fallback is off).
      await pool.db.execute(sql`delete from thread where id = ${original.thread.id}`);
      await h.drain();
      for (const copy of [fork, edit]) {
        expect((await shownFiles(copy.threadId))[0]).toMatchObject({ status: 200, text: TEXT });
      }
      expect(await h.objectExists(original.file.storageKey)).toBe(true);
    });

    it('gives a conversation whose original is in the trash a live file, and leaves the trashed one alone', async () => {
      const original = await h.conversation(owner, { text: TEXT });
      const fork = await legacyCopy(original);
      await h.call(owner, 'DELETE', `/api/threads/${original.thread.id}`);
      // While the original is in the trash its file is out of reach of the fork.
      expect(await runMigration()).toBe(1);
      expect((await shownFiles(fork.threadId))[0]).toMatchObject({ status: 200, text: TEXT });
      const [row] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, original.file.id));
      expect(row?.deletedReason).toBe('thread');
      const usage = await h.usage(owner);
      expect(usage).toMatchObject({ liveFiles: 1, pendingFiles: 1 });
      // Restoring the original brings its own file back beside the fork's.
      await h.call(owner, 'POST', `/api/threads/${original.thread.id}/restore`);
      expect(await h.usage(owner)).toMatchObject({ liveFiles: 2, pendingFiles: 0 });
    });

    it('leaves alone what is not a shared file of the same person', async () => {
      const original = await h.conversation(owner, { text: TEXT });
      const other = await seedUser(pool.db, state.organizationId);
      const strangers = await h.conversation(other, { filename: 'theirs.txt', text: 'theirs' });
      const removed = await h.conversation(owner, { filename: 'gone.txt', text: 'gone' });
      await pool.db.execute(sql`
        update attachment set deleted_at = now(), deleted_reason = 'user' where id = ${removed.file.id}`);
      const [project] = await pool.db
        .insert(schema.project)
        .values({ userId: owner, organizationId: state.organizationId, name: 'P' })
        .returning();
      const projectFile = await h.upload(owner, 'proj.txt', 'project');
      await pool.db
        .update(schema.attachment)
        .set({ projectId: project!.id })
        .where(eq(schema.attachment.id, projectFile.id));
      const part = (id: string) => ({
        type: 'data-attachment',
        data: {
          id,
          filename: 'x.txt',
          mimeType: 'text/plain',
          url: `/api/attachments/${id}/content`,
        },
      });
      const [chat] = await pool.db
        .insert(schema.thread)
        .values({ userId: owner, organizationId: state.organizationId })
        .returning();
      const parts = [
        { type: 'text', text: 'Mixed' },
        part(strangers.file.id),
        part(removed.file.id),
        part(projectFile.id),
        part('00000000-0000-4000-8000-000000000000'),
        { type: 'data-attachment', data: {} },
        part(original.file.id),
      ];
      const [message] = await pool.db
        .insert(schema.message)
        .values({ threadId: chat!.id, userId: owner, role: 'user', position: 0, parts })
        .returning();
      expect(await runMigration()).toBe(1);
      const [after] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, message!.id));
      // Only the file of the same person's own conversation was given a row.
      const [given] = await h.filesOf(chat!.id);
      expect(after!.parts).toEqual(
        parts.map((entry, index) => (index === 6 ? part(given!.id) : entry)),
      );
      expect(given!.storageKey).toBe(original.file.storageKey);
    });

    it('is registered to run after every replica runs the release', async () => {
      const { backgroundMigrations } = await import('@oci/db');
      expect(backgroundMigrations({}).map((definition) => definition.name)).toContain(
        '0.11.attachment-own-rows',
      );
    });
  });
});
