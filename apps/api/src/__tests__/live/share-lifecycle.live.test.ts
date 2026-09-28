import { eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { livePostgresAvailable, seedUser } from '../../../test/live-postgres.js';
import {
  createShareLifecycleFixture,
  type ShareLifecycleFixture,
} from '../../../test/share-lifecycle.js';

const state = vi.hoisted(() => ({ db: null as unknown, retentionDays: 30 as number | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'features'
      ? { shareLinks: true }
      : { threadRetentionDays: state.retentionDays, exemptPinnedThreads: true },
}));

import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { shareLinkRoutes } from '../../routes/share-links.js';
import { applyThreadRetention } from '../../services/lifecycle/retention.js';
import { restoreThread, softDeleteThread } from '../../services/lifecycle/trash.js';
import { createShareLink, revokeShareLink } from '../../services/share-links.js';
import { adjustStorageUsage } from '../../services/storage/quota.js';

const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: public share lifecycle', () => {
  let fixture: ShareLifecycleFixture;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/api/share', shareLinkRoutes);
  const read = (slug: string) => app.request(`/api/share/${slug}`);

  beforeAll(async () => {
    fixture = await createShareLifecycleFixture('share_lifecycle');
    state.db = fixture.db;
  });
  beforeEach(async () => {
    state.retentionDays = 30;
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.destroy();
  });

  it('serves an available conversation anonymously and counts the read', async () => {
    const thread = await fixture.thread();
    const link = await createShareLink(thread.id, fixture.userId, {});
    const response = await read(link.slug);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Private fixture content');
    expect((await fixture.linkState(link.id)).viewCount).toBe(1);
  });

  it('refuses creation for another owner or an unavailable thread', async () => {
    const thread = await fixture.thread();
    const stranger = await seedUser(fixture.db, fixture.organizationId);
    await expect(createShareLink(thread.id, stranger, {})).rejects.toMatchObject({ status: 404 });
    await softDeleteThread(thread.id, fixture.userId);
    await expect(createShareLink(thread.id, fixture.userId, {})).rejects.toMatchObject({
      status: 404,
    });
    expect(await fixture.db.select().from(schema.shareLink)).toHaveLength(0);
  });

  it('refuses a legacy deleted thread even if its link was never revoked', async () => {
    const thread = await fixture.thread();
    const link = await createShareLink(thread.id, fixture.userId, {});
    await fixture.db
      .update(schema.thread)
      .set({ deletedAt: new Date(), deletedReason: 'retention' })
      .where(eq(schema.thread.id, thread.id));
    const response = await read(link.slug);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Private fixture content');
    expect((await fixture.linkState(link.id)).viewCount).toBe(0);
    // Old retention records may lack revocations; restoring must not republish
    // those URLs either.
    await restoreThread(thread.id, fixture.userId);
    expect((await read(link.slug)).status).toBe(410);
    expect((await fixture.linkState(link.id)).revokedAt).not.toBeNull();
  });

  it.each(['expired', 'missing'] as const)(
    'refuses %s temporary expiry without waiting for cleanup',
    async (expiry) => {
      const thread = await fixture.thread({
        temporary: true,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const link = await createShareLink(thread.id, fixture.userId, {});
      await fixture.db
        .update(schema.thread)
        .set({ expiresAt: expiry === 'expired' ? new Date(Date.now() - 1_000) : null })
        .where(eq(schema.thread.id, thread.id));
      expect((await read(link.slug)).status).toBe(404);
      expect((await fixture.linkState(link.id)).viewCount).toBe(0);
      await expect(createShareLink(thread.id, fixture.userId, {})).rejects.toMatchObject({
        status: 404,
      });
      expect(await fixture.db.select().from(schema.thread)).toHaveLength(1);
    },
  );

  it.each(['revoked', 'expired'] as const)(
    'preserves 410 behavior for %s links on live threads',
    async (reason) => {
      const thread = await fixture.thread();
      const link = await createShareLink(thread.id, fixture.userId, {});
      if (reason === 'revoked') await revokeShareLink(link.id, fixture.userId);
      else
        await fixture.db
          .update(schema.shareLink)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(schema.shareLink.id, link.id));
      const response = await read(link.slug);
      expect(response.status).toBe(410);
      expect(await response.text()).not.toContain('Private fixture content');
      expect((await fixture.linkState(link.id)).viewCount).toBe(0);
    },
  );

  it('restores private history without reviving explicitly or deletion-revoked links', async () => {
    const thread = await fixture.thread();
    const withdrawn = await createShareLink(thread.id, fixture.userId, {});
    const active = await createShareLink(thread.id, fixture.userId, {});
    await revokeShareLink(withdrawn.id, fixture.userId);
    const revokedAt = (await fixture.linkState(withdrawn.id)).revokedAt;
    await softDeleteThread(thread.id, fixture.userId);
    await restoreThread(thread.id, fixture.userId);
    expect((await fixture.linkState(withdrawn.id)).revokedAt).toEqual(revokedAt);
    expect((await fixture.linkState(active.id)).revokedAt).not.toBeNull();
    expect((await read(withdrawn.slug)).status).toBe(410);
    expect((await read(active.slug)).status).toBe(410);
    const replacement = await createShareLink(thread.id, fixture.userId, {});
    expect(replacement.slug).not.toBe(active.slug);
    expect((await read(replacement.slug)).status).toBe(200);
  });

  it('retention revokes links, trashes files and adjusts counters in the same transaction', async () => {
    const thread = await fixture.thread({ createdAt: new Date('2020-01-01') });
    const child = await fixture.thread({ parentThreadId: thread.id });
    const link = await createShareLink(thread.id, fixture.userId, {});
    const [message] = await fixture.db
      .select()
      .from(schema.message)
      .where(eq(schema.message.threadId, thread.id));
    await fixture.db.insert(schema.attachment).values({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      messageId: message!.id,
      filename: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'fixture/private',
    });
    await adjustStorageUsage(fixture.db, {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      liveBytes: 12,
      liveFiles: 1,
    });
    expect(await applyThreadRetention()).toBe(1);
    expect((await read(link.slug)).status).toBe(404);
    expect((await fixture.linkState(link.id)).revokedAt).not.toBeNull();
    const [file] = await fixture.db.select().from(schema.attachment);
    expect(file?.deletedReason).toBe('thread');
    const [usage] = await fixture.db.select().from(schema.storageUsage);
    expect(usage).toMatchObject({
      liveBytes: 0,
      liveFileCount: 0,
      pendingBytes: 12,
      pendingFileCount: 1,
    });
    const [storedChild] = await fixture.db
      .select()
      .from(schema.thread)
      .where(eq(schema.thread.id, child.id));
    expect(storedChild?.parentThreadId).toBeNull();
    expect(await applyThreadRetention()).toBe(0);
    await restoreThread(thread.id, fixture.userId);
    expect((await read(link.slug)).status).toBe(410);
    const [restoredUsage] = await fixture.db.select().from(schema.storageUsage);
    expect(restoredUsage).toMatchObject({
      liveBytes: 12,
      liveFileCount: 1,
      pendingBytes: 0,
      pendingFileCount: 0,
    });
    expect((await fixture.db.select().from(schema.attachment))[0]?.deletedAt).toBeNull();
  });

  it('does not let 501 exempt/active rows starve eligible threads', async () => {
    await fixture.db.insert(schema.thread).values(
      Array.from({ length: 501 }, (_, i) => ({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        pinned: i % 2 === 0,
        createdAt: new Date('2019-01-01'),
        lastMessageAt: new Date(),
      })),
    );
    const old = await fixture.thread({ createdAt: new Date('2020-01-01') });
    expect(await applyThreadRetention()).toBe(1);
    const [row] = await fixture.db.select().from(schema.thread).where(eq(schema.thread.id, old.id));
    expect(row?.deletedReason).toBe('retention');
  });

  it('bounds a retention pass to 500 eligible threads and advances next time', async () => {
    await fixture.db.insert(schema.thread).values(
      Array.from({ length: 501 }, () => ({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        createdAt: new Date('2020-01-01'),
      })),
    );
    expect(await applyThreadRetention()).toBe(500);
    expect(await applyThreadRetention()).toBe(1);
    expect(await applyThreadRetention()).toBe(0);
  });

  it('leaves disabled retention and pinned/temporary/recent conversations alone', async () => {
    const old = new Date('2020-01-01');
    await fixture.thread({ createdAt: old });
    state.retentionDays = null;
    expect(await applyThreadRetention()).toBe(0);
    state.retentionDays = 30;
    await fixture.thread({ createdAt: old, pinned: true });
    await fixture.thread({ createdAt: old, temporary: true });
    await fixture.thread({ createdAt: old, lastMessageAt: new Date() });
    expect(await applyThreadRetention()).toBe(1);
    const [count] = await fixture.db.execute<{ count: number }>(
      sql`select count(*)::int as count from thread where deleted_at is null`,
    );
    expect(count?.count).toBe(3);
  });

  it('rolls back retention if share revocation fails', async () => {
    const thread = await fixture.thread({ createdAt: new Date('2020-01-01') });
    const link = await createShareLink(thread.id, fixture.userId, {});
    await fixture.db.execute(
      sql`create function reject_share_revoke() returns trigger language plpgsql as $$ begin raise exception 'injected revocation failure'; end $$`,
    );
    await fixture.db.execute(
      sql`create trigger reject_share_revoke before update on share_link for each row execute function reject_share_revoke()`,
    );
    try {
      await expect(applyThreadRetention()).rejects.toThrow();
      expect((await fixture.db.select().from(schema.thread))[0]?.deletedAt).toBeNull();
      expect((await fixture.linkState(link.id)).revokedAt).toBeNull();
    } finally {
      await fixture.db.execute(sql`drop trigger reject_share_revoke on share_link`);
      await fixture.db.execute(sql`drop function reject_share_revoke()`);
    }
    expect((await read(link.slug)).status).toBe(200);
  });
});
