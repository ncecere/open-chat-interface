import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedUser,
} from '../../../test/live-postgres.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
// Only the environmental DB binding is replaced. Settings, transactions, FKs,
// account cascades and storage bookkeeping are the production implementations.
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

import { applyThreadRetention } from '../../services/lifecycle/retention.js';
import { restoreThread, softDeleteThread } from '../../services/lifecycle/trash.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { updateSetting } from '../../services/settings.js';

type Operation = 'trash' | 'restore' | 'retention';
type Outcome =
  | { status: 'fulfilled'; value: undefined | number }
  | { status: 'rejected'; reason: unknown };
function errorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error) return error.code;
  return 'cause' in error ? errorCode(error.cause) : undefined;
}

const available = await livePostgresAvailable();
describe.skipIf(!available)('live lifecycle account lock ordering', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('lifecycle_owner_locks');
    const url = new URL(live.connectionString);
    url.searchParams.set('options', '-c statement_timeout=8000 -c lock_timeout=8000');
    pool = createDatabase(url.toString(), { max: 8 });
    state.db = pool.db;
    organizationId = await getDefaultOrganizationId();
    await updateSetting('retention', { threadRetentionDays: 1, exemptPinnedThreads: true });
  });
  afterEach(async () => {
    // The entire database belongs to this suite; no external account is touched.
    await pool.db.delete(schema.user);
  });
  afterAll(async () => {
    try {
      await pool?.sql.end({ timeout: 1 });
    } finally {
      await live?.destroy();
    }
  });

  async function fixture(operation: Operation) {
    const userId = await seedUser(pool.db, organizationId);
    const deletedAt = operation === 'restore' ? new Date() : null;
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({
        organizationId,
        userId,
        createdAt: new Date(Date.now() - 30 * 86_400_000),
        deletedAt,
        deletedReason: deletedAt ? 'user' : null,
      })
      .returning();
    const [message] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId,
        role: 'user',
        parts: [{ type: 'text', text: 'Synthetic lock fixture' }],
      })
      .returning();
    const [file] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId,
        userId,
        messageId: message!.id,
        filename: 'fixture.txt',
        mimeType: 'text/plain',
        sizeBytes: 8,
        storageKey: `lifecycle-fixture/${randomUUID()}`,
        deletedAt,
        deletedReason: deletedAt ? 'thread' : null,
      })
      .returning();
    // Counters are a derived cache. Exercise the supported missing-row repair
    // path, whose INSERT must check the user FK, not an already-present counter.
    expect(
      await pool.db
        .select()
        .from(schema.storageUsage)
        .where(eq(schema.storageUsage.userId, userId)),
    ).toHaveLength(0);
    return { userId, threadId: thread!.id, fileId: file!.id };
  }

  async function operate(
    operation: Operation,
    threadId: string,
    userId: string,
  ): Promise<undefined | number> {
    if (operation === 'retention') return applyThreadRetention();
    if (operation === 'trash') await softDeleteThread(threadId, userId);
    else await restoreThread(threadId, userId);
    return undefined;
  }

  it.each(['trash', 'restore', 'retention'] as const)(
    '%s repairs a missing counter without contention',
    async (operation) => {
      const { userId, threadId, fileId } = await fixture(operation);
      const result = await operate(operation, threadId, userId);
      if (operation === 'retention') expect(result).toBe(1);
      const [file] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, fileId));
      const [usage] = await pool.db
        .select()
        .from(schema.storageUsage)
        .where(eq(schema.storageUsage.userId, userId));
      expect(Boolean(file!.deletedAt)).toBe(operation !== 'restore');
      expect(usage).toMatchObject(
        operation === 'restore'
          ? { liveBytes: 8, liveFileCount: 1, pendingBytes: 0, pendingFileCount: 0 }
          : { liveBytes: 0, liveFileCount: 0, pendingBytes: 8, pendingFileCount: 1 },
      );
    },
  );

  it('rechecks eligibility after discovery and before mutating a thread', async () => {
    const { threadId, fileId, userId } = await fixture('retention');
    const transact = pool.db.transaction.bind(pool.db);
    // Intercept scheduling only: execute real SQL after discovery commits, then
    // delegate the entire production transaction, including its locks/recheck.
    const interception = vi
      .spyOn(pool.db, 'transaction')
      .mockImplementationOnce(async (body, config) => {
        await pool.db
          .update(schema.thread)
          .set({ pinned: true })
          .where(eq(schema.thread.id, threadId));
        return transact(body, config);
      });
    try {
      expect(await applyThreadRetention()).toBe(0);
      expect(interception).toHaveBeenCalledOnce();
      const [file] = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, fileId));
      expect(file!.deletedAt).toBeNull();
      expect(
        await pool.db
          .select()
          .from(schema.storageUsage)
          .where(eq(schema.storageUsage.userId, userId)),
      ).toHaveLength(0);
    } finally {
      interception.mockRestore();
    }
  });

  it('skips a busy owner before the 500-row limit without starving another owner', async () => {
    const busy = await fixture('retention');
    const free = await fixture('retention');
    await pool.db
      .update(schema.thread)
      .set({ createdAt: new Date('2000-01-01') })
      .where(eq(schema.thread.id, busy.threadId));
    await pool.db
      .update(schema.thread)
      .set({ createdAt: new Date('2001-01-01') })
      .where(eq(schema.thread.id, free.threadId));
    await pool.db.insert(schema.thread).values(
      Array.from({ length: 499 }, () => ({
        organizationId,
        userId: busy.userId,
        createdAt: new Date('2000-01-01'),
      })),
    );
    const holder = await pool.sql.reserve();
    try {
      await holder`begin`;
      await holder`select id from "user" where id = ${busy.userId} for update`;
      expect(await applyThreadRetention()).toBe(1);
      const [count] = await pool.sql<{ count: number }[]>`
        select count(*)::int as count from thread
        where user_id = ${busy.userId} and deleted_at is null
      `;
      expect(count!.count).toBe(500);
      const [retained] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, free.threadId));
      expect(retained!.deletedAt).not.toBeNull();
    } finally {
      try {
        await holder`rollback`;
      } finally {
        holder.release();
      }
    }
    expect(await applyThreadRetention()).toBe(500);
  }, 20_000);

  it('keeps completed threads after an interrupted batch and retries without double accounting', async () => {
    const first = await fixture('retention');
    const second = await fixture('retention');
    await pool.db
      .update(schema.thread)
      .set({ createdAt: new Date('2000-01-01') })
      .where(eq(schema.thread.id, first.threadId));
    await pool.db
      .update(schema.thread)
      .set({ createdAt: new Date('2001-01-01'), title: 'retention-failure-sentinel' })
      .where(eq(schema.thread.id, second.threadId));
    await pool.db.execute(sql`
      create function reject_second_retention() returns trigger language plpgsql as $$
      begin
        if NEW.title = 'retention-failure-sentinel' and OLD.deleted_at is null
          and NEW.deleted_at is not null then
          raise exception 'Injected second-thread failure';
        end if;
        return NEW;
      end $$
    `);
    await pool.db.execute(sql`
      create trigger reject_second_retention before update on thread
      for each row execute function reject_second_retention()
    `);
    try {
      await expect(applyThreadRetention()).rejects.toThrow();
      const [completed] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, first.threadId));
      const [unchanged] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, second.threadId));
      expect(completed!.deletedAt).not.toBeNull();
      expect(unchanged!.deletedAt).toBeNull();
    } finally {
      await pool.db.execute(sql`drop trigger reject_second_retention on thread`);
      await pool.db.execute(sql`drop function reject_second_retention()`);
    }
    expect(await applyThreadRetention()).toBe(1);
    expect(await applyThreadRetention()).toBe(0);
    for (const { userId } of [first, second]) {
      const [usage] = await pool.db
        .select()
        .from(schema.storageUsage)
        .where(eq(schema.storageUsage.userId, userId));
      expect(usage).toMatchObject({
        liveBytes: 0,
        liveFileCount: 0,
        pendingBytes: 8,
        pendingFileCount: 1,
      });
    }
  });

  it.each(['trash', 'restore', 'retention'] as const)(
    '%s does not lock children before an account being deleted',
    async (operation) => {
      const { userId, threadId } = await fixture(operation);
      const holder = await pool.sql.reserve();
      let work: Promise<Outcome> | undefined;
      let result: Outcome | undefined;
      let deletionError: unknown;
      let deleted = 0;
      let committed = false;
      try {
        await holder`begin`;
        const [session] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await holder`select id from "user" where id = ${userId} for update`;
        // Attach both handlers immediately, including a deadlock victim's error.
        work = operate(operation, threadId, userId).then(
          (value) => (result = { status: 'fulfilled', value }),
          (reason: unknown) => (result = { status: 'rejected', reason }),
        );
        await vi.waitFor(
          async () => {
            // A background retention sweep may skip the busy owner instead of
            // waiting. Interactive operations wait and recheck after deletion.
            if (result) return;
            const blocked = await pool.sql<{ pid: number }[]>`
            select pid from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and ${session!.pid} = any(pg_blocking_pids(pid))
          `;
            expect(blocked).toHaveLength(1);
          },
          { timeout: 5000, interval: 25 },
        );
        try {
          const rows = await holder`delete from "user" where id = ${userId} returning id`;
          await holder`commit`;
          committed = true;
          deleted = rows.length;
        } catch (error) {
          deletionError = error;
        }
      } finally {
        try {
          if (!committed) await holder`rollback`;
        } finally {
          holder.release();
          result = await work;
        }
      }
      expect.soft(errorCode(deletionError)).not.toBe('40P01');
      if (result?.status === 'rejected') expect.soft(errorCode(result.reason)).not.toBe('40P01');
      expect(deletionError).toBeUndefined();
      expect(deleted).toBe(1);
      expect(result).toMatchObject(
        operation === 'retention'
          ? { status: 'fulfilled', value: 0 }
          : { status: 'rejected', reason: { status: 404 } },
      );
      expect(
        await pool.db.select().from(schema.thread).where(eq(schema.thread.id, threadId)),
      ).toHaveLength(0);
    },
    20_000,
  );
});
