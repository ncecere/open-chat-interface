import { randomBytes, randomUUID } from 'node:crypto';
import type { UserRole } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import {
  appFor,
  call,
  errorOf,
  json,
  PASSWORD,
  personalSettingsHelpers,
} from '../../../test/personal-settings.fixtures.js';
import type { AuthenticatedUser } from '../../middleware/context.js';

/**
 * v0.10 settings for people, against real PostgreSQL: Settings → Sharing
 * (every link a person made, Revoke and Revoke all, audited, also while
 * sharing is off), Settings → Models (a default model and reasoning level
 * within what the role allows, ignored when no longer allowed) and
 * self-service account deletion (off by default per role, typed
 * confirmation, password, legal hold, last administrator, audit).
 * This suite covers deleting your own account; the shared helpers live in
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

const { and, eq, schema, sql } = await import('@oci/db');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { HELD_SELF_DELETION_MESSAGE } = await import('../../services/compliance/holds.js');
const { LAST_ADMIN_SELF_DELETION_MESSAGE } = await import(
  '../../services/admin-users/mutations.js'
);

describe.skipIf(!available)('live: v0.10 settings for people', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('personal_settings_account_deletion');
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

  const { auditEntries, exists, person } = personalSettingsHelpers(state, () => live.db);

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
