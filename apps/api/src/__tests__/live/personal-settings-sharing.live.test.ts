import { randomBytes } from 'node:crypto';
import type { MyShareLinksResponse } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { call, json, personalSettingsHelpers } from '../../../test/personal-settings.fixtures.js';
import type { AuthenticatedUser } from '../../middleware/context.js';

/**
 * v0.10 settings for people, against real PostgreSQL: Settings → Sharing
 * (every link a person made, Revoke and Revoke all, audited, also while
 * sharing is off), Settings → Models (a default model and reasoning level
 * within what the role allows, ignored when no longer allowed) and
 * self-service account deletion (off by default per role, typed
 * confirmation, password, legal hold, last administrator, audit).
 * This suite covers Settings → Sharing; the shared helpers live in
 * test/personal-settings.fixtures.ts.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { eq, schema } = await import('@oci/db');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');

describe.skipIf(!available)('live: v0.10 settings for people', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('personal_settings_sharing');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
  });
  beforeEach(async () => {
    await updateSetting('roleFeatures', { roles: {} });
    await updateSetting('features', { shareLinks: true });
    await updateSetting('chat', { defaultEffort: 'instant' });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  const { auditEntries, person } = personalSettingsHelpers(state, () => live.db);

  describe('Settings → Sharing', () => {
    async function conversation(owner: AuthenticatedUser, title: string) {
      const [thread] = await live.db
        .insert(schema.thread)
        .values({ organizationId: state.organizationId, userId: owner.id, title })
        .returning({ id: schema.thread.id });
      return thread!.id;
    }

    async function link(
      owner: AuthenticatedUser,
      threadId: string,
      extra: Partial<typeof schema.shareLink.$inferInsert> = {},
    ) {
      const [row] = await live.db
        .insert(schema.shareLink)
        .values({
          threadId,
          userId: owner.id,
          slug: randomBytes(24).toString('base64url'),
          ...extra,
        })
        .returning();
      return row!;
    }

    async function listing(actor: AuthenticatedUser, query = '') {
      return json<MyShareLinksResponse>(await call(actor, 'GET', `/me/share-links${query}`));
    }

    it('lists only the links the person made, newest first, with their conversation', async () => {
      const owner = await person();
      const other = await person();
      const plan = await conversation(owner, 'Trip plan');
      const notes = await conversation(owner, 'Notes');
      const live1 = await link(owner, plan, {
        viewCount: 3,
        createdAt: new Date(Date.now() - 3_000),
      });
      const snapshot = await link(owner, notes, {
        upToMessageId: 'message-1',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(Date.now() - 2_000),
      });
      const revoked = await link(owner, plan, {
        revokedAt: new Date(),
        createdAt: new Date(Date.now() - 1_000),
      });
      await link(other, await conversation(other, 'Not yours'));

      const body = await listing(owner);
      expect(body).toMatchObject({ total: 3, active: 2, nextOffset: null });
      expect(body.links.map((entry) => entry.id)).toEqual([revoked.id, snapshot.id, live1.id]);
      expect(body.links[2]).toEqual({
        id: live1.id,
        slug: live1.slug,
        path: `/share/${live1.slug}`,
        threadId: plan,
        threadTitle: 'Trip plan',
        threadUnavailable: false,
        upToMessageId: null,
        viewCount: 3,
        expiresAt: null,
        revokedAt: null,
        createdAt: live1.createdAt.toISOString(),
      });
      expect(body.links[1]).toMatchObject({
        threadTitle: 'Notes',
        upToMessageId: 'message-1',
        expiresAt: snapshot.expiresAt!.toISOString(),
      });
      expect(body.links[0]?.revokedAt).not.toBeNull();
      expect(JSON.stringify(body)).not.toContain('Not yours');
    });

    it('pages through many links and validates the page size', async () => {
      const owner = await person();
      const thread = await conversation(owner, 'Busy');
      for (let index = 0; index < 5; index += 1) {
        await link(owner, thread, { createdAt: new Date(Date.now() - index * 1_000) });
      }
      const first = await listing(owner, '?limit=2');
      expect(first.links).toHaveLength(2);
      expect(first).toMatchObject({ total: 5, nextOffset: 2 });
      const last = await listing(owner, '?limit=2&offset=4');
      expect(last.links).toHaveLength(1);
      expect(last.nextOffset).toBeNull();
      const all = await listing(owner);
      expect(new Set(all.links.map((entry) => entry.id)).size).toBe(5);
      expect(first.links.map((entry) => entry.id)).toEqual(
        all.links.slice(0, 2).map((entry) => entry.id),
      );

      expect((await call(owner, 'GET', '/me/share-links?limit=101')).status).toBe(422);
      expect((await call(owner, 'GET', '/me/share-links?offset=-1')).status).toBe(422);
    });

    it('marks a conversation in the trash as unavailable', async () => {
      const owner = await person();
      const thread = await conversation(owner, 'Binned');
      await link(owner, thread);
      await live.db
        .update(schema.thread)
        .set({ deletedAt: new Date() })
        .where(eq(schema.thread.id, thread));
      const [entry] = (await listing(owner)).links;
      expect(entry).toMatchObject({ threadTitle: 'Binned', threadUnavailable: true });
    });

    it('revokes one link, audited once, and refuses anyone else’s', async () => {
      const owner = await person();
      const other = await person();
      const thread = await conversation(owner, 'One');
      const target = await link(owner, thread, { upToMessageId: 'm1' });

      expect((await call(other, 'DELETE', `/share-links/links/${target.id}`)).status).toBe(404);
      const body = await json<{ link: { revokedAt: string | null } }>(
        await call(owner, 'DELETE', `/share-links/links/${target.id}`),
      );
      expect(body.link.revokedAt).not.toBeNull();
      // Revoking again changes and records nothing.
      await json(await call(owner, 'DELETE', `/share-links/links/${target.id}`));

      const entries = await auditEntries('share_link.revoke', owner.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorEmail: owner.email,
        targetType: 'share_link',
        targetId: target.id,
        metadata: { threadId: thread, snapshot: true },
      });
      expect(await auditEntries('share_link.revoke', other.id)).toHaveLength(0);
    });

    it('revokes every link the person still has, and nobody else’s', async () => {
      const owner = await person();
      const other = await person();
      const thread = await conversation(owner, 'Many');
      const earlier = new Date(Date.now() - 60_000);
      await link(owner, thread);
      await link(owner, thread, { expiresAt: new Date(Date.now() - 1_000) });
      const already = await link(owner, thread, { revokedAt: earlier });
      const theirs = await link(other, await conversation(other, 'Theirs'));

      const result = await json<{ revoked: number }>(
        await call(owner, 'POST', '/me/share-links/revoke-all'),
      );
      expect(result).toEqual({ revoked: 2 });
      const body = await listing(owner);
      expect(body.active).toBe(0);
      expect(body.links.every((entry) => entry.revokedAt !== null)).toBe(true);
      // A link revoked earlier keeps its time.
      expect(body.links.find((entry) => entry.id === already.id)?.revokedAt).toBe(
        earlier.toISOString(),
      );
      const [untouched] = await live.db
        .select({ revokedAt: schema.shareLink.revokedAt })
        .from(schema.shareLink)
        .where(eq(schema.shareLink.id, theirs.id));
      expect(untouched?.revokedAt).toBeNull();

      const entries = await auditEntries('share_link.revoke_all', owner.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetType: 'user',
        targetId: owner.id,
        metadata: { count: 2 },
      });
      // Nothing left: nothing revoked, nothing recorded.
      expect(
        await json<{ revoked: number }>(await call(owner, 'POST', '/me/share-links/revoke-all')),
      ).toEqual({ revoked: 0 });
      expect(await auditEntries('share_link.revoke_all', owner.id)).toHaveLength(1);
    });

    it('still lists and revokes links while sharing is off for the role or the instance', async () => {
      const owner = await person();
      const thread = await conversation(owner, 'Before the switch');
      const first = await link(owner, thread);
      await link(owner, thread);

      await updateSetting('roleFeatures', { roles: { user: { shareLinks: false } } });
      // Creating and managing from the conversation is refused...
      expect((await call(owner, 'POST', `/share-links/threads/${thread}`, {})).status).toBe(403);
      expect((await call(owner, 'GET', `/share-links/threads/${thread}`)).status).toBe(403);
      // ...but the person can see what is out there and take it down.
      expect((await listing(owner)).total).toBe(2);
      await json(await call(owner, 'DELETE', `/share-links/links/${first.id}`));

      await updateSetting('roleFeatures', { roles: {} });
      await updateSetting('features', { shareLinks: false });
      expect((await listing(owner)).active).toBe(1);
      // Settings keeps the Sharing tab while a link is left to revoke.
      const summary = async () =>
        (await json<{ settingsSummary: { shareLinks: number } }>(await call(owner, 'GET', '/me')))
          .settingsSummary.shareLinks;
      expect(await summary()).toBe(1);
      expect(
        await json<{ revoked: number }>(await call(owner, 'POST', '/me/share-links/revoke-all')),
      ).toEqual({ revoked: 1 });
      expect(await summary()).toBe(0);
    });
  });
});
