import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { TurnContext } from '../../services/chat/turn-context.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
// Only the environmental database binding is replaced; all locking, deletion,
// foreign keys and storage accounting below use the real implementations.
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

import { claimThread } from '../../services/chat/thread-claim.js';
import { trashLockedThread } from '../../services/lifecycle/trash-thread.js';
import { adjustStorageUsage } from '../../services/storage/usage.js';

const available = await livePostgresAvailable();
type Reserved = Awaited<ReturnType<ReturnType<typeof createDatabase>['sql']['reserve']>>;

async function rollbackAndRelease(session: Reserved) {
  try {
    await session`rollback`;
  } finally {
    session.release();
  }
}

// Drizzle wraps PostgresError in cause; inspect both deadlock victims explicitly.
function errorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error) return error.code;
  return 'cause' in error ? errorCode(error.cause) : undefined;
}

// Attach a rejection handler at launch, not after releasing a blocking session.
function outcome<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

describe.skipIf(!available)('live chat and historical file lock ordering', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('chat_file_locks');
    const url = new URL(live.connectionString);
    // Bound even service-owned statements, without wrapping/mocking transactions.
    url.searchParams.set('options', '-c statement_timeout=8000 -c lock_timeout=8000');
    pool = createDatabase(url.toString(), { max: 8 });
    state.db = pool.db;
    organizationId = await seedOrganization(pool.db);
  });
  afterAll(async () => {
    try {
      await pool?.sql.end({ timeout: 1 });
    } finally {
      await live?.destroy();
    }
  });

  async function thread(userId: string, parentThreadId: string | null = null) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ organizationId, userId, parentThreadId })
      .returning();
    return row!;
  }

  async function waitForBlockedBy(holderPid: number) {
    // The isolated database has exactly one competing operation in each test.
    // Observe an actual lock wait, rather than guessing from elapsed time.
    await vi.waitFor(
      async () => {
        const blocked = await pool.sql<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and ${holderPid} = any(pg_blocking_pids(pid))
        `;
        expect(blocked).toHaveLength(1);
      },
      { timeout: 5_000, interval: 25 },
    );
  }

  it('locks the account before claiming its thread, so account deletion wins without a deadlock', async () => {
    const userId = await seedUser(pool.db, organizationId);
    const owned = await thread(userId);
    const context: TurnContext = {
      user: { id: userId, name: 'Lock fixture', role: 'user' },
      thread: owned,
      input: {
        threadId: owned.id,
        modelSlug: 'lock-fixture',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        temporary: false,
        webSearch: false,
      },
      resolved: {
        slug: 'lock-fixture',
        displayName: 'Lock fixture',
        contextWindow: null,
        maxOutputTokens: null,
        capabilities: [],
        supportedEfforts: [],
        providerKind: 'openai',
        // Constructing a model is local; claimThread never invokes inference.
        languageModel: createOpenAI({ apiKey: 'unused' })('lock-fixture'),
      },
    };
    const holder = await pool.sql.reserve();
    let claim: ReturnType<typeof outcome<{ id: string }>> | undefined;
    let result: Awaited<ReturnType<typeof outcome<{ id: string }>>> | undefined;
    let deleteError: unknown;
    let deleted = 0;
    try {
      await holder`begin`;
      const [session] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from "user" where id = ${userId} for update`;
      claim = outcome(claimThread(context, randomUUID()));
      await waitForBlockedBy(session!.pid);
      try {
        const rows = await holder`delete from "user" where id = ${userId} returning id`;
        await holder`commit`;
        deleted = rows.length;
      } catch (error) {
        deleteError = error;
      }
    } finally {
      // If DELETE is the deadlock victim, rollback BEFORE awaiting the claim.
      try {
        await rollbackAndRelease(holder);
      } finally {
        result = await claim;
      }
    }
    expect(errorCode(deleteError)).not.toBe('40P01');
    if (result?.status === 'rejected') expect(errorCode(result.reason)).not.toBe('40P01');
    expect(deleteError).toBeUndefined();
    expect(deleted).toBe(1);
    expect(result).toMatchObject({ status: 'rejected', reason: { status: 404 } });
    expect(
      await pool.db.select().from(schema.thread).where(eq(schema.thread.id, owned.id)),
    ).toHaveLength(0);
  }, 20_000);

  it('locks trashed source files by ID before updating, leaving HIGH available while waiting for LOW', async () => {
    const userId = await seedUser(pool.db, organizationId);
    const source = await thread(userId);
    const fork = await thread(userId, source.id);
    const leaf = await thread(userId, fork.id);
    const low = '00000000-0000-4000-8000-000000000001';
    const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const parts = [high, low].map((id) => ({ type: 'data-attachment', data: { id } }));
    const [message] = await pool.db
      .insert(schema.message)
      .values({ threadId: source.id, userId, role: 'user', parts })
      .returning();
    // A fork-of-fork retains references but is not a direct child detached/locked
    // by source trash. A cross-thread history revalidation can hold this leaf.
    await pool.db.insert(schema.message).values({ threadId: leaf.id, userId, role: 'user', parts });
    // Separate inserts guarantee HIGH precedes LOW physically, opposite ID order.
    for (const id of [high, low]) {
      await pool.db.insert(schema.attachment).values({
        id,
        organizationId,
        userId,
        messageId: message!.id,
        filename: `${id}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 1,
        storageKey: randomUUID(),
      });
    }
    // Seed the allocation with the real accounting helper; trash must move it.
    await pool.db.transaction((tx) =>
      adjustStorageUsage(tx, { organizationId, userId, liveBytes: 2, liveFiles: 2 }),
    );

    const holder = await pool.sql.reserve();
    let trash: ReturnType<typeof outcome<void>> | undefined;
    let result: Awaited<ReturnType<typeof outcome<void>>> | undefined;
    try {
      await holder`begin`;
      const [session] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder`select id from attachment where id = ${low} for update`;
      trash = outcome(
        pool.db.transaction(async (tx) => {
          // Force the old unordered UPDATE to visit heap insertion order, rather
          // than accidentally passing because a primary-key scan visits LOW first.
          await tx.execute(sql`set local enable_indexscan = off`);
          await tx.execute(sql`set local enable_bitmapscan = off`);
          await tx
            .select()
            .from(schema.thread)
            .where(eq(schema.thread.id, source.id))
            .for('update');
          await trashLockedThread(tx, source, 'user', new Date());
        }),
      );
      await waitForBlockedBy(session!.pid);
      const probe = await pool.sql.reserve();
      try {
        await probe`begin`;
        await probe`select id from thread where id = ${leaf.id} for update nowait`;
        // Old code already holds HIGH and fails with 55P03. Sorted pre-locking
        // waits at LOW without touching HIGH, so this independent probe succeeds.
        const rows = await probe`select id from attachment where id = ${high} for update nowait`;
        expect(rows).toHaveLength(1);
      } finally {
        await rollbackAndRelease(probe);
      }
    } finally {
      // Also runs on a failed NOWAIT assertion: never strand the trash promise.
      try {
        await rollbackAndRelease(holder);
      } finally {
        result = await trash;
      }
    }
    expect(result).toMatchObject({ status: 'fulfilled' });
    const files = await pool.db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.userId, userId));
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.deletedAt !== null && file.deletedReason === 'thread')).toBe(
      true,
    );
    const [usage] = await pool.db
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, userId));
    expect(usage).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      pendingBytes: 2,
      pendingFileCount: 2,
    });
  }, 20_000);
});
