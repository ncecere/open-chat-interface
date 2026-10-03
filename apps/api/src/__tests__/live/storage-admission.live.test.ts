import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { StorageDriver } from '../../services/storage/driver.js';

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as unknown as StorageDriver,
  putHook: null as null | (() => Promise<void>),
  puts: 0,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'features'
      ? { attachments: true }
      : {
          driver: 'local',
          maxFileBytes: 1024,
          maxFilesPerMessage: 10,
          allowedMimeTypes: ['text/plain'],
          trashRetentionDays: 30,
        },
}));
vi.mock('../../services/storage/index.js', async (original) => ({
  ...(await original<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));

import {
  deleteAttachment,
  getOwnedAttachment,
  listAttachments,
  uploadAttachment,
} from '../../services/attachments/index.js';
import { inspectIncomingAttachments } from '../../services/chat/attachment-context.js';
import {
  purgeTrashedThread,
  restoreThread,
  softDeleteThread,
} from '../../services/lifecycle/trash.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';
import { getStorageUsage, recomputeStorageUsage } from '../../services/storage/quota.js';
import { drainDeletedObjects, reconcileStorage } from '../../services/storage/reaper.js';

const available = await livePostgresAvailable();
const root = mkdtempSync(join(tmpdir(), 'oci-storage-admission-'));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!available)('live PostgreSQL and local blobs: storage admission', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let userId: string;
  let local: LocalStorageDriver;
  const upload = (text = '123456') =>
    uploadAttachment({
      userId,
      role: 'user',
      filename: 'file.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from(text),
    });
  const rows = () => pool.db.select().from(schema.attachment);
  const usage = () => getStorageUsage(userId, 'user');
  async function policy(maxTotalBytes: number | null, maxFileCount: number | null = null) {
    await pool.db.insert(schema.storagePolicy).values({
      organizationId: state.organizationId,
      role: 'user',
      enabled: true,
      maxTotalBytes,
      maxFileCount,
    });
  }
  async function linkedFile() {
    const file = await upload();
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId })
      .returning();
    const [message] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId,
        role: 'user',
        position: 0,
        parts: [{ type: 'data-attachment', data: { id: file.id } }],
      })
      .returning();
    await pool.db
      .update(schema.attachment)
      .set({ messageId: message!.id })
      .where(eq(schema.attachment.id, file.id));
    return { thread: thread!, message: message!, file };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('storage_admission');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, state.organizationId);
    await LocalStorageDriver.ensureRoot(root);
    local = new LocalStorageDriver(root);
    state.driver = {
      name: 'local',
      put: async (key, bytes, contentType) => {
        state.puts++;
        await state.putHook?.();
        return local.put(key, bytes, contentType);
      },
      get: local.get.bind(local),
      delete: local.delete.bind(local),
      exists: local.exists.bind(local),
      list: local.list.bind(local),
    };
  });
  beforeEach(async () => {
    state.db = pool.db;
    state.putHook = null;
    state.puts = 0;
    await pool.db.execute(
      sql`alter table attachment drop constraint if exists injected_upload_failure`,
    );
    await pool.db.execute(sql`drop trigger if exists injected_cleanup_failure on attachment`);
    await pool.db.execute(sql`drop function if exists injected_cleanup_failure()`);
    await pool.db.delete(schema.thread);
    await pool.db.delete(schema.attachment);
    await pool.db.delete(schema.storageUsage);
    await pool.db.delete(schema.storagePolicy);
    await pool.db.delete(schema.deletedObject);
    rmSync(root, { recursive: true, force: true });
    await LocalStorageDriver.ensureRoot(root);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['bytes', 'count'] as const)(
    'admits exactly one of six concurrent uploads at the %s limit',
    async (kind) => {
      await policy(kind === 'bytes' ? 10 : null, kind === 'count' ? 1 : null);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => upload()));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(5);
      expect(state.puts).toBe(1);
      expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
      expect(await rows()).toHaveLength(1);
    },
  );

  it('reserves capacity and hides the upload while the blob writer is paused', async () => {
    await policy(10);
    const entered = gate();
    const finish = gate();
    state.putHook = async () => {
      if (state.puts === 1) {
        entered.release();
        await finish.promise;
      }
    };
    const first = upload();
    try {
      await entered.promise;
      const [pending] = await rows();
      expect(pending?.uploadPending).toBe(true);
      expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
      expect(await listAttachments(userId)).toEqual([]);
      await expect(getOwnedAttachment(pending!.id, userId)).rejects.toMatchObject({ status: 404 });
      await expect(inspectIncomingAttachments([pending!.id], userId, 'user')).rejects.toMatchObject(
        {
          status: 404,
        },
      );
      await expect(upload()).rejects.toMatchObject({ status: 422 });
      expect(state.puts).toBe(1);
      await recomputeStorageUsage();
      expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
    } finally {
      finish.release();
      await first;
    }
    expect((await rows())[0]?.uploadPending).toBe(false);
  });

  it('checks actual attachment totals rather than accepting drifted counters', async () => {
    await policy(10);
    await upload();
    await pool.db.update(schema.storageUsage).set({ liveBytes: 0, liveFileCount: 0 });
    await expect(upload()).rejects.toMatchObject({ status: 422 });
    expect(state.puts).toBe(1);
  });

  it('rolls back a failed reservation before performing blob I/O', async () => {
    await pool.db.execute(
      sql`alter table attachment add constraint injected_upload_failure check (upload_pending = false) not valid`,
    );
    await expect(upload()).rejects.toThrow();
    expect(state.puts).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(await usage()).toMatchObject({ liveBytes: 0, liveFileCount: 0 });
  });

  it('releases a failed blob write and durably queues cleanup, allowing a retry', async () => {
    await policy(6);
    state.putHook = async () => {
      throw new Error('Injected storage error');
    };
    await expect(upload()).rejects.toThrow('Injected storage error');
    expect(await rows()).toHaveLength(0);
    expect(await usage()).toMatchObject({ liveBytes: 0, liveFileCount: 0 });
    expect(await pool.db.select().from(schema.deletedObject)).toHaveLength(1);
    state.putHook = null;
    await expect(upload()).resolves.toMatchObject({ sizeBytes: 6 });
  });

  it('queues a blob written before metadata completion failed', async () => {
    await pool.db.execute(
      sql`alter table attachment add constraint injected_upload_failure check (upload_pending = true) not valid`,
    );
    await expect(upload()).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    const [queued] = await pool.db.select().from(schema.deletedObject);
    expect(await local.exists(queued!.storageKey)).toBe(true);
    expect(await usage()).toMatchObject({ liveBytes: 0, liveFileCount: 0 });
    expect(await drainDeletedObjects()).toBe(1);
    expect(await local.exists(queued!.storageKey)).toBe(false);
  });

  it('drains a deletion queued earlier in the same millisecond', async () => {
    // PostgreSQL keeps microseconds and JavaScript milliseconds.
    await pool.db.execute(
      sql`alter table attachment add constraint injected_upload_failure check (upload_pending = true) not valid`,
    );
    await expect(upload()).rejects.toThrow();
    await pool.db.execute(
      sql`update deleted_object set next_attempt_at = '2026-10-03T12:00:00.123456Z'`,
    );
    expect(await drainDeletedObjects(new Date('2026-10-03T12:00:00.123Z'))).toBe(1);
  });

  it('preserves successfully committed metadata after a simulated lost completion reply', async () => {
    state.db = new Proxy(pool.db, {
      get(target, key) {
        if (key === 'update')
          return () => ({
            set: (values: Partial<typeof schema.attachment.$inferInsert>) => ({
              where: (condition: ReturnType<typeof sql>) => ({
                returning: async () => {
                  await target.update(schema.attachment).set(values).where(condition).returning();
                  throw new Error('Injected lost commit reply');
                },
              }),
            }),
          });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(upload()).rejects.toThrow('Injected lost commit reply');
    const [stored] = await rows();
    expect(stored?.uploadPending).toBe(false);
    expect(await local.get(stored!.storageKey)).toEqual(Buffer.from('123456'));
    expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
    expect(await pool.db.select().from(schema.deletedObject)).toHaveLength(0);
  });

  it('does not consider a pending reservation an orphan or a missing completed file', async () => {
    await pool.db.insert(schema.attachment).values({
      organizationId: state.organizationId,
      userId,
      filename: 'file.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storageKey: 'pending-object',
      uploadPending: true,
    });
    await local.put('pending-object', Buffer.from('123456'), 'text/plain');
    const report = await reconcileStorage({
      deleteOrphans: true,
      now: new Date(Date.now() + 48 * 3600_000),
    });
    expect(report).toEqual({ orphanedObjects: 0, missingObjects: 0, queuedForDeletion: 0 });
  });

  it('soft-deletes an attachment exactly once under concurrent requests', async () => {
    const file = await upload();
    await Promise.all(Array.from({ length: 6 }, () => deleteAttachment(file.id, userId)));
    expect(await usage()).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      pendingBytes: 6,
      pendingFileCount: 1,
    });
  });

  it('serializes thread deletion with deletion of its linked file', async () => {
    const { thread, file } = await linkedFile();
    await Promise.all([softDeleteThread(thread.id, userId), deleteAttachment(file.id, userId)]);
    expect(await usage()).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      pendingBytes: 6,
      pendingFileCount: 1,
    });
  });

  it('blocks restore from bypassing byte or file-count limits', async () => {
    const { thread } = await linkedFile();
    await softDeleteThread(thread.id, userId);
    await policy(6, 1);
    await upload();
    await expect(restoreThread(thread.id, userId)).rejects.toMatchObject({ status: 422 });
    const [stored] = await pool.db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.id, thread.id));
    expect(stored?.deletedAt).not.toBeNull();
    expect(await usage()).toMatchObject({
      liveBytes: 6,
      liveFileCount: 1,
      pendingBytes: 6,
      pendingFileCount: 1,
    });
  });

  it('admits only one of a restore and upload racing for the last capacity', async () => {
    const { thread } = await linkedFile();
    await softDeleteThread(thread.id, userId);
    await policy(6, 1);
    const results = await Promise.allSettled([restoreThread(thread.id, userId), upload()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
  });

  it('hard deletion and message cascades release live and trashed counters', async () => {
    const { thread } = await linkedFile();
    await softDeleteThread(thread.id, userId);
    await purgeTrashedThread(thread.id, userId);
    expect(await usage()).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      pendingBytes: 0,
      pendingFileCount: 0,
    });
    const next = await linkedFile();
    await pool.db.delete(schema.message).where(eq(schema.message.id, next.message.id));
    expect(await usage()).toMatchObject({ liveBytes: 0, liveFileCount: 0 });
    expect(await pool.db.select().from(schema.deletedObject)).toHaveLength(2);
  });

  it('reconciliation retains concurrent upload deltas and zeros owners without files', async () => {
    await upload();
    await Promise.all([recomputeStorageUsage(), upload(), upload(), upload()]);
    expect(await usage()).toMatchObject({ liveBytes: 24, liveFileCount: 4 });
    await pool.db.delete(schema.attachment);
    await pool.db.update(schema.storageUsage).set({ liveBytes: 999, liveFileCount: 5 });
    await recomputeStorageUsage();
    expect(await usage()).toMatchObject({ liveBytes: 0, liveFileCount: 0 });
  });

  it('retains capacity when failed-upload compensation itself fails', async () => {
    await policy(6);
    await pool.db.execute(sql`create function injected_cleanup_failure() returns trigger language plpgsql as $$
      begin raise exception 'Injected cleanup failure'; end $$`);
    await pool.db.execute(sql`create trigger injected_cleanup_failure before delete on attachment
      for each row execute function injected_cleanup_failure()`);
    state.putHook = async () => {
      throw new Error('Injected write failure');
    };
    await expect(upload()).rejects.toThrow('Injected write failure');
    expect((await rows())[0]?.uploadPending).toBe(true);
    expect(await usage()).toMatchObject({ liveBytes: 6, liveFileCount: 1 });
    state.putHook = null;
    await expect(upload()).rejects.toMatchObject({ status: 422 });
    expect(state.puts).toBe(1);
  });

  it('never expires an uncertain upload reservation merely because it is old', async () => {
    await policy(6);
    await pool.db.insert(schema.attachment).values({
      organizationId: state.organizationId,
      userId,
      filename: 'old.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      storageKey: 'old-pending',
      uploadPending: true,
      createdAt: new Date(Date.now() - 7 * 24 * 3600_000),
    });
    await expect(upload()).rejects.toMatchObject({ status: 422 });
    expect(state.puts).toBe(0);
  });

  it('does not overwrite a delta committed while reconciliation is waiting', async () => {
    await upload();
    const owner = await pool.sql.reserve();
    await owner`begin`;
    await owner`select user_id from storage_usage where user_id = ${userId} for update`;
    const rebuilding = recomputeStorageUsage();
    try {
      await vi.waitFor(async () => {
        const [waiting] = await pool.db.execute<{ count: number }>(sql`select count(*)::int as count
          from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        expect(waiting?.count).toBeGreaterThan(0);
      });
      await owner`insert into attachment (organization_id, user_id, filename, mime_type, size_bytes, storage_key)
        values (${state.organizationId}, ${userId}, 'other.txt', 'text/plain', 6, 'reconcile-fixture')`;
      await owner`update storage_usage set live_bytes = live_bytes + 6, live_file_count = live_file_count + 1 where user_id = ${userId}`;
    } finally {
      await owner`commit`;
      owner.release();
      await rebuilding;
    }
    expect(await usage()).toMatchObject({ liveBytes: 12, liveFileCount: 2 });
  });

  it('permits account deletion during blob I/O and queues its eventual object for cleanup', async () => {
    const other = await seedUser(pool.db, state.organizationId);
    const entered = gate();
    const finish = gate();
    state.putHook = async () => {
      entered.release();
      await finish.promise;
    };
    const uploading = uploadAttachment({
      userId: other,
      role: 'user',
      filename: 'file.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from('123456'),
    }).catch((error: unknown) => error);
    try {
      await entered.promise;
      await pool.db.delete(schema.user).where(eq(schema.user.id, other));
    } finally {
      finish.release();
    }
    expect(await uploading).toBeInstanceOf(Error);
    expect(await rows()).toHaveLength(0);
    expect(
      await pool.db.select().from(schema.storageUsage).where(eq(schema.storageUsage.userId, other)),
    ).toHaveLength(0);
    expect(await drainDeletedObjects()).toBe(1);
    expect((await local.list()).objects).toHaveLength(0);
  });

  it('rejects admission when the account has already disappeared', async () => {
    await expect(
      uploadAttachment({
        userId: crypto.randomUUID(),
        role: 'user',
        filename: 'file.txt',
        declaredMimeType: 'text/plain',
        bytes: Buffer.from('123456'),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(state.puts).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it('does not deadlock admission with account deletion before the attachment FK check', async () => {
    const other = await seedUser(pool.db, state.organizationId);
    await pool.db
      .insert(schema.storageUsage)
      .values({ organizationId: state.organizationId, userId: other });
    const blocker = await pool.sql.reserve();
    await blocker`select pg_advisory_lock(912804)`;
    await pool.db.execute(sql`create function pause_upload_admission() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(912804); return new; end $$`);
    await pool.db.execute(sql`create trigger pause_upload_admission before insert on attachment
      for each row execute function pause_upload_admission()`);
    const uploading = uploadAttachment({
      userId: other,
      role: 'user',
      filename: 'race.txt',
      declaredMimeType: 'text/plain',
      bytes: Buffer.from('123456'),
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    let deleting: Promise<{ error: unknown }> | undefined;
    let outcomes: Array<{ error: unknown }> = [];
    try {
      await vi.waitFor(async () => {
        const [row] = await pool.db.execute<{ count: number }>(sql`select count(*)::int as count
          from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`);
        expect(row?.count).toBe(1);
      });
      deleting = pool.db
        .delete(schema.user)
        .where(eq(schema.user.id, other))
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      await vi.waitFor(async () => {
        const [row] = await pool.db.execute<{ count: number }>(sql`select count(*)::int as count
          from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
          and wait_event in ('transactionid', 'tuple')`);
        expect(row?.count).toBeGreaterThan(0);
      });
    } finally {
      await blocker`select pg_advisory_unlock(912804)`;
      blocker.release();
      outcomes = await Promise.all([uploading, ...(deleting ? [deleting] : [])]);
      await pool.db.execute(sql`drop trigger pause_upload_admission on attachment`);
      await pool.db.execute(sql`drop function pause_upload_admission()`);
    }
    function sqlState(error: unknown): unknown {
      if (!error || typeof error !== 'object') return undefined;
      if ('code' in error) return error.code;
      return 'cause' in error ? sqlState(error.cause) : undefined;
    }
    expect(outcomes.map((outcome) => sqlState(outcome.error))).not.toContain('40P01');
    expect(outcomes[1]?.error).toBeNull();
  });

  it('does not hold a database connection during blob I/O', async () => {
    await pool.sql.end({ timeout: 1 });
    pool = createDatabase(live.connectionString, { max: 1 });
    state.db = pool.db;
    state.putHook = async () => {
      await pool.db.execute(sql`select 1`);
    };
    await expect(upload()).resolves.toMatchObject({ sizeBytes: 6 });
  });
});
