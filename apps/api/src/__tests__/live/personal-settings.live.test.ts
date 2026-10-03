import { randomBytes, randomUUID } from 'node:crypto';
import type { MyShareLinksResponse, UserRole } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings, AuthenticatedUser } from '../../middleware/context.js';

/**
 * v0.10 settings for people, against real PostgreSQL: Settings → Sharing
 * (every link a person made, Revoke and Revoke all, audited, also while
 * sharing is off), Settings → Models (a default model and reasoning level
 * within what the role allows, ignored when no longer allowed) and
 * self-service account deletion (off by default per role, typed
 * confirmation, password, legal hold, last administrator, audit).
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

const { and, eq, schema, sql } = await import('@oci/db');
const { hashPassword } = await import('better-auth/crypto');
const { meRoutes } = await import('../../routes/me.js');
const { shareLinkRoutes } = await import('../../routes/share-links.js');
const { rolesRoutes } = await import('../../routes/admin/roles.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { HELD_SELF_DELETION_MESSAGE } = await import('../../services/compliance/holds.js');
const { LAST_ADMIN_SELF_DELETION_MESSAGE } = await import(
  '../../services/admin-users/mutations.js'
);

const PASSWORD = 'Personal-settings-123!';

function appFor(actor: AuthenticatedUser, sessionId: string | null = null) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', actor);
    c.set('sessionId', sessionId);
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/roles', rolesRoutes);
  app.route('/me', meRoutes);
  app.route('/share-links', shareLinkRoutes);
  return app;
}

async function call(actor: AuthenticatedUser, method: string, path: string, body?: unknown) {
  return appFor(actor).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

async function errorOf(response: Response, status: number): Promise<string> {
  const body = await json<{ error: { message: string } }>(response, status);
  return body.error.message;
}

describe.skipIf(!available)('live: v0.10 settings for people', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('personal_settings');
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

  async function person(
    role: UserRole = 'user',
    { password = true }: { password?: boolean } = {},
  ): Promise<AuthenticatedUser> {
    const email = `${randomUUID().slice(0, 8)}@people.test`;
    const id = await seedUser(live.db, state.organizationId, { role, email });
    if (password) {
      await live.db.insert(schema.account).values({
        id: randomUUID(),
        accountId: id,
        providerId: 'credential',
        userId: id,
        password: await hashPassword(PASSWORD),
      });
    } else {
      await live.db.insert(schema.account).values({
        id: randomUUID(),
        accountId: `sso-${id}`,
        providerId: 'campus-sso',
        userId: id,
      });
    }
    return {
      id,
      role,
      email,
      name: 'Test User',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    };
  }

  async function auditEntries(action: string, actorUserId?: string) {
    return live.db
      .select()
      .from(schema.auditLog)
      .where(
        actorUserId
          ? and(eq(schema.auditLog.action, action), eq(schema.auditLog.actorUserId, actorUserId))
          : eq(schema.auditLog.action, action),
      );
  }

  async function exists(id: string) {
    const rows = await live.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    return rows.length === 1;
  }

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

  describe('Settings → Models: personal defaults', () => {
    let modelIds: Record<string, string>;

    beforeAll(async () => {
      const [provider] = await live.db
        .insert(schema.provider)
        .values({
          organizationId: state.organizationId,
          kind: 'openai-compatible',
          label: 'Never called',
          baseUrl: 'http://127.0.0.1:9/v1',
        })
        .returning();
      const rows = await live.db
        .insert(schema.model)
        .values([
          {
            organizationId: state.organizationId,
            providerId: provider!.id,
            slug: 'everyday',
            upstreamModelId: 'everyday',
            displayName: 'Everyday',
            capabilities: [],
            supportedEfforts: [],
            visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
            isDefault: true,
          },
          {
            organizationId: state.organizationId,
            providerId: provider!.id,
            slug: 'thinker',
            upstreamModelId: 'thinker',
            displayName: 'Thinker',
            capabilities: ['effort_control'],
            supportedEfforts: ['instant', 'low', 'high'],
            visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
          },
          {
            organizationId: state.organizationId,
            providerId: provider!.id,
            slug: 'staff-only',
            upstreamModelId: 'staff-only',
            displayName: 'Staff only',
            capabilities: [],
            supportedEfforts: [],
            visibleToRoles: ['admin'],
          },
        ])
        .returning({ id: schema.model.id, slug: schema.model.slug });
      modelIds = Object.fromEntries(rows.map((row) => [row.slug, row.id]));
    });

    interface MeChat {
      chat: {
        defaultEffort: string;
        instanceDefaultEffort: string;
        defaultModelSlug: string | null;
        defaultProblems: string[];
      };
      preferences: { defaultModelSlug: string | null; defaultEffort: string | null };
    }

    const me = async (actor: AuthenticatedUser) => json<MeChat>(await call(actor, 'GET', '/me'));
    const save = (actor: AuthenticatedUser, body: unknown) =>
      call(actor, 'PATCH', '/me/preferences', body);

    it('starts from the instance defaults when nothing is saved', async () => {
      const actor = await person();
      await updateSetting('chat', { defaultEffort: 'low' });
      expect((await me(actor)).chat).toEqual({
        defaultEffort: 'low',
        instanceDefaultEffort: 'low',
        defaultModelSlug: null,
        defaultProblems: [],
        reasoningEfforts: ['instant', 'low', 'medium', 'high'],
      });
    });

    it('saves a model and level the role allows, and starts from them', async () => {
      const actor = await person();
      const saved = await json<{ preferences: MeChat['preferences'] }>(
        await save(actor, { defaultModelSlug: 'thinker', defaultEffort: 'high' }),
      );
      expect(saved.preferences).toMatchObject({
        defaultModelSlug: 'thinker',
        defaultEffort: 'high',
      });
      expect((await me(actor)).chat).toMatchObject({
        defaultModelSlug: 'thinker',
        defaultEffort: 'high',
        instanceDefaultEffort: 'instant',
        defaultProblems: [],
      });

      // Saving the level alone keeps the model; null returns to the instance default.
      await json(await save(actor, { defaultEffort: 'low' }));
      expect((await me(actor)).chat).toMatchObject({
        defaultModelSlug: 'thinker',
        defaultEffort: 'low',
      });
      await json(await save(actor, { defaultModelSlug: null, defaultEffort: null }));
      expect((await me(actor)).chat).toMatchObject({
        defaultModelSlug: null,
        defaultEffort: 'instant',
        defaultProblems: [],
      });
    });

    it('refuses a model or level the role may not use, or the model does not offer', async () => {
      const actor = await person();
      expect(await errorOf(await save(actor, { defaultModelSlug: 'staff-only' }), 422)).toBe(
        'That model is not available to your role.',
      );
      expect(await errorOf(await save(actor, { defaultModelSlug: 'no-such-model' }), 422)).toBe(
        'That model is not available to your role.',
      );
      expect(
        await errorOf(
          await save(actor, { defaultModelSlug: 'thinker', defaultEffort: 'medium' }),
          422,
        ),
      ).toBe('Thinker does not offer the Medium reasoning level.');
      expect(await save(actor, { defaultEffort: 'extreme' }).then((r) => r.status)).toBe(422);

      await updateSetting('roleFeatures', {
        roles: { user: { reasoningEfforts: ['instant', 'low'] } },
      });
      expect(await errorOf(await save(actor, { defaultEffort: 'high' }), 422)).toBe(
        'The High reasoning level is not available to your role.',
      );
      // An administrator may choose a model only administrators see.
      const admin = await person('admin');
      await json(await save(admin, { defaultModelSlug: 'staff-only', defaultEffort: 'instant' }));
      expect((await me(admin)).chat.defaultModelSlug).toBe('staff-only');

      const after = await me(actor);
      expect(after.preferences).toMatchObject({ defaultModelSlug: null, defaultEffort: null });
    });

    it('ignores a saved model that is no longer available and reports it', async () => {
      const actor = await person();
      await updateSetting('chat', { defaultEffort: 'low' });
      await json(await save(actor, { defaultModelSlug: 'thinker', defaultEffort: 'high' }));

      await live.db
        .update(schema.model)
        .set({ visibleToRoles: ['admin'] })
        .where(eq(schema.model.id, modelIds.thinker!));
      try {
        const body = await me(actor);
        // The saved values stay; what applies falls back to the instance.
        expect(body.preferences).toMatchObject({ defaultModelSlug: 'thinker' });
        expect(body.chat).toMatchObject({
          defaultModelSlug: null,
          // The level is still allowed for the role, with no saved model to narrow it.
          defaultEffort: 'high',
          defaultProblems: ['model'],
        });
        // Saving a level alone is not refused because of the hidden model.
        await json(await save(actor, { defaultEffort: 'low' }));
      } finally {
        await live.db
          .update(schema.model)
          .set({ visibleToRoles: ['admin', 'auditor', 'user', 'restricted'] })
          .where(eq(schema.model.id, modelIds.thinker!));
      }
    });

    it('ignores a saved level the role or model no longer allows and reports it', async () => {
      const actor = await person();
      await updateSetting('chat', { defaultEffort: 'low' });
      await json(await save(actor, { defaultModelSlug: 'thinker', defaultEffort: 'high' }));

      await updateSetting('roleFeatures', {
        roles: { user: { reasoningEfforts: ['instant', 'low'] } },
      });
      expect((await me(actor)).chat).toMatchObject({
        defaultModelSlug: 'thinker',
        defaultEffort: 'low',
        defaultProblems: ['effort'],
      });

      await updateSetting('roleFeatures', { roles: {} });
      await live.db
        .update(schema.model)
        .set({ supportedEfforts: ['instant', 'low'] })
        .where(eq(schema.model.id, modelIds.thinker!));
      try {
        expect((await me(actor)).chat).toMatchObject({
          defaultModelSlug: 'thinker',
          defaultEffort: 'low',
          defaultProblems: ['effort'],
        });
      } finally {
        await live.db
          .update(schema.model)
          .set({ supportedEfforts: ['instant', 'low', 'high'] })
          .where(eq(schema.model.id, modelIds.thinker!));
      }
      expect((await me(actor)).chat.defaultProblems).toEqual([]);
    });
  });

  describe('deleting your own account', () => {
    async function allow(role: UserRole = 'user') {
      await updateSetting('roleFeatures', { roles: { [role]: { accountDeletion: true } } });
    }
    const remove = (actor: AuthenticatedUser, body: unknown) =>
      call(actor, 'POST', '/me/delete-account', body);

    it('is refused while the role does not allow it, which is the default', async () => {
      const actor = await person();
      expect(
        await errorOf(await remove(actor, { confirmEmail: actor.email, password: PASSWORD }), 403),
      ).toBe('Deleting your own account is not available for your role. Ask your administrator.');
      expect(await exists(actor.id)).toBe(true);
      // Switched on for another role only.
      await allow('restricted');
      expect((await remove(actor, { confirmEmail: actor.email, password: PASSWORD })).status).toBe(
        403,
      );
    });

    it('needs the email typed and the current password', async () => {
      await allow();
      const actor = await person();
      expect(
        await errorOf(
          await remove(actor, { confirmEmail: 'someone@else.test', password: PASSWORD }),
          422,
        ),
      ).toBe('Type your email address exactly as shown to confirm.');
      expect(await errorOf(await remove(actor, { confirmEmail: actor.email }), 422)).toBe(
        'Enter your password to delete your account.',
      );
      expect(
        await errorOf(
          await remove(actor, { confirmEmail: actor.email, password: 'wrong-password!' }),
          422,
        ),
      ).toBe('Your password is not correct.');
      expect(await exists(actor.id)).toBe(true);
      const [failure] = await auditEntries('user.delete.failure', actor.id);
      expect(failure).toMatchObject({
        targetId: actor.id,
        metadata: { self: true, reason: 'invalid_password' },
      });
      expect((await remove(actor, { confirmEmail: actor.email, extra: true })).status).toBe(422);
    });

    it('deletes the account and what it owns, and records it as their own deletion', async () => {
      await allow();
      const actor = await person();
      const [thread] = await live.db
        .insert(schema.thread)
        .values({ organizationId: state.organizationId, userId: actor.id, title: 'Mine' })
        .returning({ id: schema.thread.id });
      await live.db.insert(schema.shareLink).values({
        threadId: thread!.id,
        userId: actor.id,
        slug: randomBytes(24).toString('base64url'),
      });

      const response = await remove(actor, {
        // Case and outer spaces do not matter.
        confirmEmail: `  ${actor.email.toUpperCase()} `,
        password: PASSWORD,
      });
      expect(await json(response)).toEqual({ ok: true });
      // This browser's session cookies are expired at once.
      expect(response.headers.getSetCookie().some((cookie) => /max-age=0/i.test(cookie))).toBe(
        true,
      );
      expect(await exists(actor.id)).toBe(false);
      const threads = await live.db
        .select({ id: schema.thread.id })
        .from(schema.thread)
        .where(eq(schema.thread.userId, actor.id));
      expect(threads).toHaveLength(0);

      const [entry] = await live.db
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.action, 'user.delete'), eq(schema.auditLog.targetId, actor.id)),
        );
      expect(entry).toMatchObject({
        // The account is gone, so the entry keeps the email it was made with.
        actorUserId: null,
        actorEmail: actor.email,
        targetType: 'user',
      });
      expect(entry?.metadata).toMatchObject({
        email: actor.email,
        role: 'user',
        self: true,
        deletion: {
          type: 'user',
          id: actor.id,
          reason: 'user',
          self: true,
          permanent: true,
          conversations: 1,
          shareLinks: 1,
        },
      });
    });

    it('is refused in a session an administrator opened as the person', async () => {
      await allow();
      const admin = await person('admin');
      const actor = await person('user', { password: false });
      const sessionId = randomUUID();
      await live.db.insert(schema.session).values({
        id: sessionId,
        userId: actor.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        impersonatedBy: admin.id,
      });
      const response = await appFor(actor, sessionId).request('/me/delete-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmEmail: actor.email }),
      });
      expect(await errorOf(response, 403)).toBe(
        'An administrator session cannot delete this account. Use People → Users.',
      );
      expect(await exists(actor.id)).toBe(true);
    });

    it('needs no password for an account that signs in only through the organisation', async () => {
      await allow();
      const actor = await person('user', { password: false });
      expect(await json(await remove(actor, { confirmEmail: actor.email }))).toEqual({ ok: true });
      expect(await exists(actor.id)).toBe(false);
    });

    it('is refused while the person is on legal hold', async () => {
      await allow();
      const actor = await person();
      await live.db.insert(schema.legalHold).values({
        organizationId: state.organizationId,
        userId: actor.id,
        userEmail: actor.email,
        reason: 'Litigation',
      });
      expect(
        await errorOf(await remove(actor, { confirmEmail: actor.email, password: PASSWORD }), 409),
      ).toBe(HELD_SELF_DELETION_MESSAGE);
      expect(await exists(actor.id)).toBe(true);
      const deletions = await live.db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.action, 'user.delete'), eq(schema.auditLog.targetId, actor.id)),
        );
      expect(deletions).toHaveLength(0);
    });

    it('is refused for the last administrator, and allowed once there is another', async () => {
      await allow('admin');
      await live.db.update(schema.user).set({ role: 'user' }).where(eq(schema.user.role, 'admin'));
      const admin = await person('admin');
      expect(
        await errorOf(await remove(admin, { confirmEmail: admin.email, password: PASSWORD }), 409),
      ).toBe(LAST_ADMIN_SELF_DELETION_MESSAGE);
      expect(await exists(admin.id)).toBe(true);

      await person('admin');
      expect(
        await json(await remove(admin, { confirmEmail: admin.email, password: PASSWORD })),
      ).toEqual({ ok: true });
      expect(await exists(admin.id)).toBe(false);
      const [count] = await live.db.execute<{ n: number }>(
        sql`select count(*)::int as n from "user" where role = 'admin'`,
      );
      expect(count?.n).toBe(1);
    });

    it('is switched on per role from Roles & access', async () => {
      const admin = await person('admin');
      const body = await json<{ roleFeatures: { accountDeletion: boolean } }>(
        await call(admin, 'PUT', '/admin/roles/user', { accountDeletion: true }),
      );
      expect(body.roleFeatures.accountDeletion).toBe(true);
      const actor = await person();
      const me = await json<{ features: { accountDeletion: boolean } }>(
        await call(actor, 'GET', '/me'),
      );
      expect(me.features.accountDeletion).toBe(true);
      expect(
        await json(await remove(actor, { confirmEmail: actor.email, password: PASSWORD })),
      ).toEqual({ ok: true });
    });
  });
});
