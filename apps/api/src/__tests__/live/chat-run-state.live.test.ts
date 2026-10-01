import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

import { readOwnedRunState } from '../../services/chat/run-state.js';

const available = await livePostgresAvailable();
describe.skipIf(!available)('live exact durable replay status', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;
  let userId: string;
  let stranger: string;
  beforeAll(async () => {
    live = await createLiveDatabase('chat_run_state');
    pool = createDatabase(live.connectionString, { max: 2 });
    state.db = pool.db;
    organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, organizationId);
    stranger = await seedUser(pool.db, organizationId);
  });
  afterAll(async () => {
    try {
      await pool?.sql.end({ timeout: 1 });
    } finally {
      await live?.destroy();
    }
  });
  async function fixture(status: 'streaming' | 'complete' | 'error' | 'cancelled' = 'streaming') {
    const [thread] = await pool.db
      .insert(schema.thread)
      .values({ organizationId, userId })
      .returning();
    const [message] = await pool.db
      .insert(schema.message)
      .values({
        threadId: thread!.id,
        userId,
        role: 'assistant',
        status,
        parts: [{ type: 'text', text: 'Payload must not be returned by status lookup' }],
      })
      .returning();
    return { runId: message!.id, threadId: thread!.id, userId };
  }

  it.each(['streaming', 'complete', 'error', 'cancelled'] as const)(
    'classifies %s without returning history or payload',
    async (status) => {
      const identity = await fixture(status);
      expect(await readOwnedRunState(identity)).toBe(
        status === 'streaming' ? 'streaming' : 'terminal',
      );
    },
  );
  it('checks the original run even when a successor is streaming', async () => {
    const identity = await fixture('complete');
    const [successor] = await pool.db
      .insert(schema.message)
      .values({
        threadId: identity.threadId,
        userId,
        role: 'assistant',
        status: 'streaming',
        parts: [],
      })
      .returning();
    expect(await readOwnedRunState(identity)).toBe('terminal');
    expect(await readOwnedRunState({ ...identity, runId: successor!.id })).toBe('streaming');
  });
  it('rejects missing, foreign, mismatched and non-assistant identities', async () => {
    const identity = await fixture();
    expect(await readOwnedRunState({ ...identity, runId: randomUUID() })).toBe('missing');
    expect(await readOwnedRunState({ ...identity, userId: stranger })).toBe('missing');
    expect(await readOwnedRunState({ ...identity, threadId: randomUUID() })).toBe('missing');
    await pool.db
      .update(schema.message)
      .set({ role: 'user' })
      .where(eq(schema.message.id, identity.runId));
    expect(await readOwnedRunState(identity)).toBe('missing');
    await pool.db
      .update(schema.message)
      .set({ role: 'assistant' })
      .where(eq(schema.message.id, identity.runId));
    await pool.db
      .update(schema.thread)
      .set({ userId: stranger })
      .where(eq(schema.thread.id, identity.threadId));
    expect(await readOwnedRunState(identity)).toBe('missing');
  });
  it.each(['deleted', 'expired', 'missing-expiry'] as const)(
    'rejects a %s thread without mutating its lifecycle state',
    async (kind) => {
      const identity = await fixture();
      const patch =
        kind === 'deleted'
          ? { deletedAt: new Date() }
          : { temporary: true, expiresAt: kind === 'expired' ? new Date(0) : null };
      await pool.db.update(schema.thread).set(patch).where(eq(schema.thread.id, identity.threadId));
      const [before] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, identity.threadId));
      expect(await readOwnedRunState(identity)).toBe('missing');
      const [after] = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, identity.threadId));
      expect(after).toEqual(before);
    },
  );
  it('accepts a live temporary thread and ignores expiry fields on permanent threads', async () => {
    const identity = await fixture();
    await pool.db
      .update(schema.thread)
      .set({ temporary: true, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.thread.id, identity.threadId));
    expect(await readOwnedRunState(identity)).toBe('streaming');
    await pool.db
      .update(schema.thread)
      .set({ temporary: false, expiresAt: new Date(0) })
      .where(eq(schema.thread.id, identity.threadId));
    expect(await readOwnedRunState(identity)).toBe('streaming');
  });
  it('does not enqueue work for an already-aborted reader', async () => {
    const identity = await fixture();
    const abort = new AbortController();
    abort.abort();
    const transaction = vi.spyOn(pool.db, 'transaction');
    try {
      await expect(readOwnedRunState(identity, abort.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });
  it('abandons a reader cancelled while waiting for a pool slot', async () => {
    const identity = await fixture();
    const first = await pool.sql.reserve();
    const second = await pool.sql.reserve();
    const abort = new AbortController();
    let firstReleased = false;
    const result = readOwnedRunState(identity, abort.signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      abort.abort();
      first.release();
      firstReleased = true;
      expect(await result).toMatchObject({ error: { name: 'AbortError' } });
    } finally {
      if (!firstReleased) first.release();
      second.release();
      await result;
    }
    expect(await readOwnedRunState(identity)).toBe('streaming');
  });

  it('bounds a blocked lookup and restores the session statement timeout', async () => {
    const identity = await fixture();
    const holder = await pool.sql.reserve();
    try {
      await holder`begin`;
      await holder`lock table message in access exclusive mode`;
      await expect(readOwnedRunState(identity)).rejects.toMatchObject({ cause: { code: '57014' } });
      // Holder still consumes one of the two connections, so this checks the
      // exact connection used by the failed status transaction.
      const [settings] = await pool.sql`show statement_timeout`;
      expect(settings!.statement_timeout).toBe('0');
    } finally {
      try {
        await holder`rollback`;
      } finally {
        holder.release();
      }
    }
    expect(await readOwnedRunState(identity)).toBe('streaming');
  }, 5000);
});
