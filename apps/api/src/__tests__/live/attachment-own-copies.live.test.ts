import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copiesHarness, DAY, defaultSettings } from '../../../test/attachment-copies.fixtures.js';
import { liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { S3StorageDriver } from '../../services/storage/s3-driver.js';

/**
 * A fork's and an edit's files survive deleting the conversation they were
 * made from (#358). A fork, and an edit that keeps its question's file, shared
 * the original's attachment id, so the file belonged to the original and went
 * with it: trash, "Delete now", the automatic purge or retention made every
 * fork's and edit's file answer 404, with nothing to say so.
 *
 * Real routes (fork, edit, delete, restore, the content route), real services
 * for every purge path, real PostgreSQL with its storage triggers, and S3
 * storage (MinIO locally, VersityGW in CI): each case deletes the original and
 * asserts the copies still serve their bytes and the object is still stored.
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

describe.skipIf(!available)('live: files of forks and edits outlive their source (#358)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let driver: S3StorageDriver;
  let owner: string;
  const h = copiesHarness({
    get pool() {
      return pool;
    },
    state: state as never,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('attachment_copies');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    driver = new S3StorageDriver(liveS3Config);
    state.driver = driver;
  });
  beforeEach(async () => {
    state.settings = defaultSettings();
    await pool.db.execute(sql`delete from storage_policy`);
    owner = await seedUser(pool.db, state.organizationId);
  });
  afterAll(async () => {
    await h.cleanup();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const TEXT = 'The drainage trench costs $650 and the project starts in March 2027.';

  /** A conversation with a file, a fork of it and an edit of its question. */
  async function family(userId = owner) {
    const original = await h.conversation(userId, { text: TEXT });
    const forked = await h.fork(userId, original.thread.id, original.reply.id);
    const edited = await h.edit(userId, original.thread.id, original.question.id, 'Again?');
    const [forkFile] = await h.filesOf(forked);
    const [editFile] = await h.filesOf(edited);
    return { ...original, forked, edited, forkFile: forkFile!, editFile: editFile! };
  }
  type Family = Awaited<ReturnType<typeof family>>;

  async function expectCopiesIntact(f: Family, userId = owner) {
    for (const file of [f.forkFile, f.editFile]) {
      expect(await h.served(userId, file.id)).toEqual({ status: 200, text: TEXT });
    }
    expect(await h.objectExists(f.file.storageKey)).toBe(true);
    // Still theirs: owned by their own messages, live, in the person's list.
    for (const [file, threadId] of [
      [f.forkFile, f.forked],
      [f.editFile, f.edited],
    ] as const) {
      const [row] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(row?.deletedAt).toBeNull();
      expect((await h.filesOf(threadId)).map((entry) => entry.id)).toEqual([file.id]);
    }
  }

  it('gives a fork and an edit a row of their own for the file, on the same stored object', async () => {
    const f = await family();
    expect(f.forkFile.id).not.toBe(f.file.id);
    expect(f.editFile.id).not.toBe(f.file.id);
    expect(f.forkFile.id).not.toBe(f.editFile.id);
    for (const copy of [f.forkFile, f.editFile]) {
      expect(copy.userId).toBe(owner);
      expect(copy.storageKey).toBe(f.file.storageKey);
      expect(copy.filename).toBe(f.file.filename);
      expect(copy.mimeType).toBe(f.file.mimeType);
      expect(copy.sizeBytes).toBe(f.file.sizeBytes);
      // The extracted-text cache comes with the copy.
      expect(copy.extractedText).toBe(TEXT);
    }
    // Their messages show the copies, not the original's id.
    for (const [threadId, file] of [
      [f.forked, f.forkFile],
      [f.edited, f.editFile],
    ] as const) {
      const parts = (
        await pool.db.select().from(schema.message).where(eq(schema.message.threadId, threadId))
      ).flatMap((message) => message.parts);
      const shown = parts.filter((part) => part.type === 'data-attachment') as Array<{
        data: { id: string; url: string };
      }>;
      expect(shown.map((part) => part.data.id)).toEqual([file.id]);
      expect(shown[0]!.data.url).toBe(`/api/attachments/${file.id}/content`);
    }
    // The original is untouched.
    expect((await h.filesOf(f.thread.id)).map((file) => file.id)).toEqual([f.file.id]);
    expect(await h.served(owner, f.forkFile.id)).toEqual({ status: 200, text: TEXT });
    expect(await h.served(owner, f.editFile.id)).toEqual({ status: 200, text: TEXT });
  });

  it('serves a copy to its owner only', async () => {
    const f = await family();
    const stranger = await seedUser(pool.db, state.organizationId);
    expect((await h.served(stranger, f.forkFile.id)).status).toBe(404);
    expect((await h.served(stranger, f.editFile.id)).status).toBe(404);
  });

  it('counts a copy in the storage meter and the Attachments list, once per owning conversation', async () => {
    const f = await family();
    const size = f.file.sizeBytes;
    expect(await h.usage(owner)).toMatchObject({ liveBytes: 3 * size, liveFiles: 3 });
    const listed = (await (await h.call(owner, 'GET', '/api/attachments')).json()) as {
      attachments: Array<{ id: string; sizeBytes: number }>;
    };
    expect(listed.attachments.map((file) => file.id).sort()).toEqual(
      [f.file.id, f.forkFile.id, f.editFile.id].sort(),
    );
    expect(listed.attachments.reduce((total, file) => total + file.sizeBytes, 0)).toBe(3 * size);
    // Moving the original to the trash releases only its own row.
    expect((await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`)).status).toBe(200);
    expect(await h.usage(owner)).toMatchObject({
      liveBytes: 2 * size,
      liveFiles: 2,
      pendingBytes: size,
      pendingFiles: 1,
    });
    // Restoring brings it back, as before.
    expect((await h.call(owner, 'POST', `/api/threads/${f.thread.id}/restore`)).status).toBe(200);
    expect(await h.usage(owner)).toMatchObject({ liveBytes: 3 * size, liveFiles: 3 });
    // Forking never fails for lack of allowance: the files are already stored.
    await pool.db.insert(schema.storagePolicy).values({
      organizationId: state.organizationId,
      role: 'user',
      maxTotalBytes: 1,
      maxFileCount: 1,
      maxFileBytes: size,
    });
    await h.fork(owner, f.thread.id, f.reply.id);
    expect((await h.usage(owner)).liveFiles).toBe(4);
  });

  const PATHS: Array<{ path: string; run: (f: Family) => Promise<void> }> = [
    {
      path: 'trash, then Delete now',
      run: async (f) => {
        expect((await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`)).status).toBe(200);
        // The fork's files still open while the original sits in the trash.
        expect(await h.served(owner, f.forkFile.id)).toEqual({ status: 200, text: TEXT });
        expect(
          (await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}/permanent`)).status,
        ).toBe(200);
      },
    },
    {
      path: 'Empty trash',
      run: async (f) => {
        await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`);
        const emptied = await h.call(owner, 'DELETE', '/api/threads/trash');
        expect(((await emptied.json()) as { purged: number }).purged).toBe(1);
      },
    },
    {
      path: 'the automatic trash purge',
      run: async (f) => {
        await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`);
        await h.expireInTrash(f.thread.id);
        const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
        expect(await purgeExpiredTrash()).toBeGreaterThanOrEqual(1);
      },
    },
    {
      path: "an administrator's retention period, then the trash purge",
      run: async (f) => {
        // Only the original is old: the fork and the edit were made just now.
        await pool.db
          .update(schema.thread)
          .set({ lastMessageAt: new Date(Date.now() - 60 * DAY) })
          .where(eq(schema.thread.id, f.thread.id));
        const { applyThreadRetention } = await import('../../services/lifecycle/retention.js');
        expect(await applyThreadRetention()).toBe(1);
        const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
        await h.expireInTrash(f.thread.id);
        await purgeExpiredTrash();
      },
    },
    {
      path: 'a temporary chat expiring',
      run: async (f) => {
        await pool.db
          .update(schema.thread)
          .set({ temporary: true, expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(schema.thread.id, f.thread.id));
        const { purgeExpiredTemporaryThreads } = await import('../../services/threads.js');
        expect(await purgeExpiredTemporaryThreads()).toBe(1);
      },
    },
    {
      path: 'deleting the file in Settings, then the trash purge',
      run: async (f) => {
        expect((await h.call(owner, 'DELETE', `/api/attachments/${f.file.id}`)).status).toBe(200);
        await pool.db.execute(sql`
          update attachment set deleted_at = now() - interval '30 days'
          where id = ${f.file.id}`);
        const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
        await purgeExpiredTrash();
      },
    },
    {
      path: 'bulk delete: several conversations to the trash, then Empty trash',
      run: async (f) => {
        const spare = await h.conversation(owner, { filename: 'spare.txt', text: 'spare' });
        for (const id of [f.thread.id, spare.thread.id])
          await h.call(owner, 'DELETE', `/api/threads/${id}`);
        const emptied = await h.call(owner, 'DELETE', '/api/threads/trash');
        expect(((await emptied.json()) as { purged: number }).purged).toBe(2);
      },
    },
  ];

  it.each(PATHS)('keeps the fork’s and the edit’s files: $path', async ({ run }) => {
    const f = await family();
    await run(f);
    await h.drain();
    // The original's own row is gone ...
    expect(
      await pool.db.select().from(schema.attachment).where(eq(schema.attachment.id, f.file.id)),
    ).toHaveLength(0);
    // ... and the copies are intact, with the object still stored.
    await expectCopiesIntact(f);
  });

  it('deleting the original really removes its row, and only its row', async () => {
    const f = await family();
    await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`);
    await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}/permanent`);
    await h.drain();
    expect(
      await pool.db.select().from(schema.attachment).where(eq(schema.attachment.id, f.file.id)),
    ).toHaveLength(0);
    expect((await h.served(owner, f.file.id)).status).toBe(404);
    await expectCopiesIntact(f);
    expect(await h.usage(owner)).toMatchObject({
      liveBytes: 2 * f.file.sizeBytes,
      liveFiles: 2,
      pendingBytes: 0,
    });
  });

  it('keeps conversations and their files when a project is deleted, and deletes the project’s own files', async () => {
    const [project] = await pool.db
      .insert(schema.project)
      .values({ userId: owner, organizationId: state.organizationId, name: 'Grants' })
      .returning();
    const f = await (async () => {
      const original = await h.conversation(owner, { text: TEXT, projectId: project!.id });
      const forked = await h.fork(owner, original.thread.id, original.reply.id);
      return { ...original, forked, forkFile: (await h.filesOf(forked))[0]! };
    })();
    const { uploadAttachment } = await import('../../services/attachments/index.js');
    const projectFile = await uploadAttachment({
      userId: owner,
      role: 'user',
      filename: 'brief.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from('project brief'),
      project: { id: project!.id, maxFiles: 10 },
    });
    const [stored] = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.id, projectFile.id));
    h.touched.add(stored!.storageKey);
    const { deleteProject } = await import('../../services/projects.js');
    await deleteProject(project!.id, owner);
    await h.drain();
    expect(await h.objectExists(stored!.storageKey)).toBe(false);
    expect(await h.served(owner, f.file.id)).toEqual({ status: 200, text: TEXT });
    expect(await h.served(owner, f.forkFile.id)).toEqual({ status: 200, text: TEXT });
  });

  it('keeps the files of a held person: nothing is purged while the hold lasts, and a later purge of the original spares the fork', async () => {
    const f = await family();
    await pool.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: owner,
      userEmail: 'held@example.test',
      reason: 'Matter 2026-41',
    });
    // Moving to the trash still works; destroying does not.
    expect((await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`)).status).toBe(200);
    expect((await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}/permanent`)).status).toBe(
      409,
    );
    await h.expireInTrash(f.thread.id);
    const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
    expect(await purgeExpiredTrash()).toBe(0);
    await h.drain();
    expect(
      await pool.db.select().from(schema.attachment).where(eq(schema.attachment.id, f.file.id)),
    ).toHaveLength(1);
    expect(await h.objectExists(f.file.storageKey)).toBe(true);
    expect(await h.served(owner, f.forkFile.id)).toEqual({ status: 200, text: TEXT });
    // The hold is lifted: the purge removes the original, never the copies.
    await pool.db.execute(sql`update legal_hold set lifted_at = now() where user_id = ${owner}`);
    await purgeExpiredTrash();
    await h.drain();
    await expectCopiesIntact(f);
  });

  it('deletes the object, and releases the storage, once nothing uses it', async () => {
    const f = await family();
    const key = f.file.storageKey;
    // Each conversation goes in turn; the object stays until the last one.
    for (const id of [f.thread.id, f.forked]) {
      await h.call(owner, 'DELETE', `/api/threads/${id}`);
      await h.call(owner, 'DELETE', `/api/threads/${id}/permanent`);
      await h.drain();
      expect(await h.objectExists(key)).toBe(true);
    }
    expect(await h.served(owner, f.editFile.id)).toEqual({ status: 200, text: TEXT });
    await h.call(owner, 'DELETE', `/api/threads/${f.edited}`);
    await h.call(owner, 'DELETE', `/api/threads/${f.edited}/permanent`);
    await h.drain();
    expect(await h.objectExists(key)).toBe(false);
    expect(await h.usage(owner)).toEqual({
      liveBytes: 0,
      liveFiles: 0,
      pendingBytes: 0,
      pendingFiles: 0,
    });
    // Nothing is left queued.
    const queued = await pool.db.execute(
      sql`select 1 from deleted_object where deleted_at is null and storage_key = ${key}`,
    );
    expect(queued).toHaveLength(0);
  });

  it('deletes the object when the account goes with all its conversations', async () => {
    const f = await family();
    const admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    const { deleteUser } = await import('../../services/admin-users/mutations.js');
    await deleteUser({ id: admin, email: 'admin@example.test' }, owner);
    await h.drain();
    expect(await h.objectExists(f.file.storageKey)).toBe(false);
  });

  it('deletes an unsent upload by the sweep and leaves the files of sent messages alone', async () => {
    const f = await family();
    const stray = await h.upload(owner, 'stray.txt', 'never sent');
    await pool.db.execute(
      sql`update attachment set created_at = now() - interval '3 days' where id = ${stray.id}`,
    );
    const { purgeUnsentUploads } = await import('../../services/attachments/index.js');
    expect(await purgeUnsentUploads()).toBe(1);
    await h.drain();
    expect(await h.objectExists(stray.storageKey)).toBe(false);
    await expectCopiesIntact({ ...f });
    expect(await h.served(owner, f.file.id)).toEqual({ status: 200, text: TEXT });
  });

  it('shows the fork its own file after the original is permanently deleted', async () => {
    // The sequence of the walk: fork, then trash and Delete now at once.
    const f = await family();
    await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}`);
    await h.call(owner, 'DELETE', `/api/threads/${f.thread.id}/permanent`);
    await h.drain();
    const messages = (await (await h.call(owner, 'GET', `/api/threads/${f.forked}`)).json()) as {
      messages: Array<{ parts: Array<{ type: string; data?: { id: string } }> }>;
    };
    const ids = messages.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'data-attachment' ? [part.data!.id] : [])),
    );
    expect(ids).toEqual([f.forkFile.id]);
    expect(await h.served(owner, ids[0]!)).toEqual({ status: 200, text: TEXT });
  });

  describe('the storage object queue', () => {
    it('parks the object of a row deleted while another row uses it, and deletes it with the last', async () => {
      const f = await family();
      await pool.db.execute(sql`delete from attachment where id = ${f.file.id}`);
      const queued = await pool.db.execute<{ next: string }>(sql`
        select next_attempt_at::text as next from deleted_object
        where storage_key = ${f.file.storageKey} and deleted_at is null`);
      expect(queued.map((row) => row.next)).toEqual(['infinity']);
      await h.drain();
      expect(await h.objectExists(f.file.storageKey)).toBe(true);
      await pool.db.execute(
        sql`delete from attachment where id in (${f.forkFile.id}, ${f.editFile.id})`,
      );
      await h.drain();
      expect(await h.objectExists(f.file.storageKey)).toBe(false);
    });

    it('does not delete an object that a row uses even when an entry for it is due', async () => {
      // As a delete queued by a release that does not know about shared files.
      const f = await family();
      await pool.db.insert(schema.deletedObject).values({
        storageKey: f.file.storageKey,
        sizeBytes: f.file.sizeBytes,
        userId: owner,
      });
      await h.drain();
      expect(await h.objectExists(f.file.storageKey)).toBe(true);
      expect(await h.served(owner, f.forkFile.id)).toEqual({ status: 200, text: TEXT });
      const [entry] = await pool.db
        .select()
        .from(schema.deletedObject)
        .where(eq(schema.deletedObject.storageKey, f.file.storageKey));
      expect(entry?.deletedAt).not.toBeNull();
    });

    it('deletes the object when two rows using it are deleted at the same moment', async () => {
      const f = await family();
      await pool.db.execute(sql`delete from attachment where id = ${f.file.id}`);
      // Two transactions, each deleting one of the last two rows while the
      // other's is still there: each sees the other's row, so each parks the
      // object and neither queues it as free.
      const [a, b] = await Promise.all([pool.sql.reserve(), pool.sql.reserve()]);
      try {
        await a`begin`;
        await b`begin`;
        await a`delete from attachment where id = ${f.forkFile.id}`;
        // The second delete runs its triggers (seeing the first row still
        // there) and then waits for the first transaction, which updates the
        // same storage counter.
        const second = b`delete from attachment where id = ${f.editFile.id}`.then(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await a`commit`;
        await second;
        await b`commit`;
      } finally {
        a.release();
        b.release();
      }
      const free = await pool.db.execute(sql`
        select 1 from deleted_object
        where storage_key = ${f.file.storageKey} and deleted_at is null and next_attempt_at <> 'infinity'`);
      expect(free).toHaveLength(0);
      await h.drain();
      expect(await h.objectExists(f.file.storageKey)).toBe(false);
    });
  });
});
