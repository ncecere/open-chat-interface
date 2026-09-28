import { eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { livePostgresAvailable } from '../../../test/live-postgres.js';
import {
  createShareLifecycleFixture,
  type ShareLifecycleFixture,
} from '../../../test/share-lifecycle.js';
import { shareLifecycleBarrier } from '../../../test/share-lifecycle-barrier.js';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/settings.js', () => ({ getSetting: async () => ({ shareLinks: true }) }));

import { restoreThread, softDeleteThread } from '../../services/lifecycle/trash.js';
import { createShareLink, getPublicShare } from '../../services/share-links.js';
import { adjustStorageUsage } from '../../services/storage/quota.js';

const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: share lifecycle races through real services', () => {
  let fixture: ShareLifecycleFixture;
  beforeAll(async () => {
    fixture = await createShareLifecycleFixture('share_lifecycle_races');
    state.db = fixture.db;
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.destroy();
  });

  it('rejects reads and creation queued behind deletion', async () => {
    const thread = await fixture.thread();
    const link = await createShareLink(thread.id, fixture.userId, {});
    const barrier = await shareLifecycleBarrier(fixture, 'delete');
    const tasks: Promise<unknown>[] = [];
    try {
      const deletion = softDeleteThread(thread.id, fixture.userId);
      tasks.push(deletion);
      await barrier.waitForWriter();
      // Attach rejection handlers immediately; assertions happen after unlocking.
      const creation = createShareLink(thread.id, fixture.userId, {}).catch((error) => error);
      const read = getPublicShare(link.slug).catch((error) => error);
      tasks.push(creation, read);
      await barrier.waitForThreadWaiters(2);
      await barrier.release();
      await deletion;
      expect(await creation).toMatchObject({ status: 404 });
      expect(await read).toMatchObject({ status: 404 });
      expect((await fixture.linkState(link.id)).viewCount).toBe(0);
    } finally {
      await barrier.release();
      await Promise.allSettled(tasks);
      await barrier.destroy();
    }
  });

  it('deletion sees and revokes a link whose creation won the thread lock', async () => {
    const thread = await fixture.thread();
    const barrier = await shareLifecycleBarrier(fixture, 'create');
    const tasks: Promise<unknown>[] = [];
    try {
      const creation = createShareLink(thread.id, fixture.userId, {});
      tasks.push(creation);
      await barrier.waitForWriter();
      const deletion = softDeleteThread(thread.id, fixture.userId);
      tasks.push(deletion);
      await barrier.waitForThreadWaiters(1);
      await barrier.release();
      const link = await creation;
      await deletion;
      expect((await fixture.linkState(link.id)).revokedAt).not.toBeNull();
      await restoreThread(thread.id, fixture.userId);
      await expect(getPublicShare(link.slug)).rejects.toMatchObject({ status: 410 });
    } finally {
      await barrier.release();
      await Promise.allSettled(tasks);
      await barrier.destroy();
    }
  });

  it.each(['thread', 'link'] as const)(
    'rechecks %s expiry after waiting to increment the view counter',
    async (target) => {
      const thread = await fixture.thread({
        temporary: true,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const link = await createShareLink(thread.id, fixture.userId, {});
      // The deadline is long enough to reach the final update, then the test
      // deliberately holds that update until wall-clock expiry has passed.
      const expiresAt = new Date(Date.now() + 1_000);
      if (target === 'thread') {
        await fixture.db
          .update(schema.thread)
          .set({ expiresAt })
          .where(eq(schema.thread.id, thread.id));
      } else {
        await fixture.db
          .update(schema.shareLink)
          .set({ expiresAt })
          .where(eq(schema.shareLink.id, link.id));
      }
      const owner = await fixture.client.reserve();
      let read: Promise<unknown> | undefined;
      try {
        await owner`begin`;
        await owner`select id from share_link where id = ${link.id} for update`;
        read = getPublicShare(link.slug).catch((error) => error);
        await vi.waitFor(async () => {
          const [row] = await fixture.db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like 'update "share_link"%'
        `);
          expect(row?.count).toBe(1);
        });
        await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(expiresAt.getTime()), {
          timeout: 2_000,
        });
        await owner`commit`;
        expect(await read).toMatchObject({ status: 410 });
        expect((await fixture.linkState(link.id)).viewCount).toBe(0);
      } finally {
        await owner`rollback`;
        owner.release();
        await read;
      }
    },
  );

  it('does not serve content when revocation wins the final counter update', async () => {
    const thread = await fixture.thread();
    const link = await createShareLink(thread.id, fixture.userId, {});
    const owner = await fixture.client.reserve();
    let read: Promise<unknown> | undefined;
    try {
      await owner`begin`;
      await owner`update share_link set revoked_at = clock_timestamp() where id = ${link.id}`;
      read = getPublicShare(link.slug).catch((error) => error);
      await vi.waitFor(async () => {
        const [row] = await fixture.db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like 'update "share_link"%'
        `);
        expect(row?.count).toBe(1);
      });
      await owner`commit`;
      expect(await read).toMatchObject({ status: 410, details: { reason: 'revoked' } });
      expect((await fixture.linkState(link.id)).viewCount).toBe(0);
    } finally {
      await owner`rollback`;
      owner.release();
      await read;
    }
  });

  it('serializes duplicate delete/restore requests without double-counting files', async () => {
    const thread = await fixture.thread();
    const [message] = await fixture.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, thread.id));
    await fixture.db.insert(schema.attachment).values({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      messageId: message!.id,
      filename: 'fixture.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'fixture/race',
    });
    await adjustStorageUsage(fixture.db, {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      liveBytes: 12,
      liveFiles: 1,
    });
    const deletions = await Promise.allSettled([
      softDeleteThread(thread.id, fixture.userId),
      softDeleteThread(thread.id, fixture.userId),
    ]);
    expect(deletions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const restores = await Promise.allSettled([
      restoreThread(thread.id, fixture.userId),
      restoreThread(thread.id, fixture.userId),
    ]);
    expect(restores.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await fixture.db.select().from(schema.storageUsage))[0]).toMatchObject({
      liveBytes: 12,
      liveFileCount: 1,
      pendingBytes: 0,
      pendingFileCount: 0,
    });
  });
});
