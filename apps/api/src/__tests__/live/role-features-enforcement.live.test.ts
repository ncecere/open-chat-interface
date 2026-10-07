import { DEFAULT_ROLE_FEATURES, rolesAccessSchema, type UserRole } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import {
  type Actor,
  ALL_ON,
  call,
  json,
  roleFeatureHelpers,
  seedActorsAndModels,
} from '../../../test/role-features.fixtures.js';

/**
 * Feature entitlements per role against real PostgreSQL. This suite covers
 * the default rules, toggling a role feature, deleting your own
 * account and web search; the shared fixtures live in test/role-features.fixtures.ts.
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

const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { assertAttachmentUseAllowed } = await import('../../services/attachments/index.js');
const { assertShareLinkManagementAllowed } = await import('../../services/share-links.js');
const { assertTemporaryChatAllowed } = await import('../../services/threads.js');
const { resolveTurnContext } = await import('../../services/chat/turn-context.js');
const { assertRoleFeature } = await import('../../services/role-features.js');

describe.skipIf(!available)('live: feature entitlements per role', () => {
  let live: LiveDatabase;
  const actors = {} as Record<UserRole, Actor>;

  const { branchingStatus, checks, putRole, threadFor, turnInput } = roleFeatureHelpers(
    state,
    actors,
  );

  beforeAll(async () => {
    live = await createLiveDatabase('role_features_enforcement');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    await seedActorsAndModels(live.db, state.organizationId, actors);
  });

  beforeEach(async () => {
    // Every case starts from the built-in role defaults and all switches on.
    await updateSetting('roleFeatures', { roles: {} });
    await updateSetting('features', ALL_ON);
    await updateSetting('search', {
      enabled: true,
      provider: 'searxng',
      baseUrl: 'http://127.0.0.1:9',
      encryptedApiKey: null,
      maxResults: 5,
    });
  });

  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  describe('defaults preserve the previous fixed rules', () => {
    it('denies restricted attachments, share links, temporary chats, projects, memory and artifacts, and deleting your own account to everyone', async () => {
      expect(await checks('restricted')).toEqual({
        attachments: 403,
        shareLinks: 403,
        temporaryChat: 403,
        webSearch: 'allowed',
        branching: 'allowed',
        projects: 403,
        memory: 403,
        artifacts: 403,
        accountDeletion: 403,
      });
      for (const role of ['admin', 'auditor', 'user'] as const) {
        expect(await checks(role)).toEqual({
          attachments: 'allowed',
          shareLinks: 'allowed',
          temporaryChat: 'allowed',
          webSearch: 'allowed',
          branching: 'allowed',
          projects: 'allowed',
          memory: 'allowed',
          artifacts: 'allowed',
          accountDeletion: 403,
        });
      }
    });

    it('keeps the role refusal codes and uses role-neutral wording', async () => {
      await expect(assertAttachmentUseAllowed('restricted')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Attachments are not available for your role',
      });
      await expect(assertShareLinkManagementAllowed('restricted')).rejects.toMatchObject({
        status: 403,
        message: 'Public share links are not available for your role',
      });
      await expect(assertTemporaryChatAllowed('restricted')).rejects.toMatchObject({
        status: 403,
        message: 'Temporary chats are not available for your role',
      });
      // A refused role is reported ahead of a switched-off instance, as before.
      await updateSetting('features', { ...ALL_ON, attachments: false });
      await expect(assertAttachmentUseAllowed('restricted')).rejects.toMatchObject({
        status: 403,
      });
      await expect(assertAttachmentUseAllowed('user')).rejects.toMatchObject({
        status: 422,
        message: 'File uploads are disabled on this instance',
      });
    });

    it('reports the defaults on /me and the roles summary', async () => {
      const me = await json<{ features: Record<string, boolean> }>(
        await call(actors.restricted, 'GET', '/me'),
      );
      expect(me.features).toMatchObject({
        attachments: false,
        shareLinks: false,
        temporaryChat: false,
        webSearch: true,
        branching: true,
        projects: false,
        memory: false,
        artifacts: false,
        accountDeletion: false,
      });

      const summary = rolesAccessSchema.parse(
        await json(await call(actors.admin, 'GET', '/admin/roles')),
      );
      const restricted = summary.roles.find((entry) => entry.role === 'restricted')!;
      expect(restricted.roleFeatures).toEqual(DEFAULT_ROLE_FEATURES.restricted);
      expect(restricted.features).toEqual({
        attachments: false,
        shareLinks: false,
        temporaryChat: false,
        webSearch: true,
        branching: true,
        projects: false,
        memory: false,
        artifacts: false,
        accountDeletion: false,
      });
      expect(restricted.fixedRules).toEqual([]);
      expect(summary.roles.find((entry) => entry.role === 'auditor')?.fixedRules).toEqual([
        'Can view administration but cannot change it.',
      ]);
    });
  });

  describe('toggling a role feature changes enforcement', () => {
    it.each([
      'attachments',
      'shareLinks',
      'temporaryChat',
      'webSearch',
      'branching',
      'projects',
      'memory',
      'artifacts',
    ] as const)('%s follows the user role switch', async (feature) => {
      expect((await checks('user'))[feature]).toBe('allowed');

      await json(await putRole('user', { [feature]: false }));
      expect((await checks('user'))[feature]).toBe(403);
      const me = await json<{ features: Record<string, boolean> }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(me.features[feature]).toBe(false);

      // Other roles keep their own values.
      expect((await checks('admin'))[feature]).toBe('allowed');

      await json(await putRole('user', { [feature]: true }));
      expect((await checks('user'))[feature]).toBe('allowed');
    });

    it('lets an administrator open restricted features without a code change', async () => {
      await json(
        await putRole('restricted', {
          attachments: true,
          shareLinks: true,
          temporaryChat: true,
          projects: true,
          memory: true,
          artifacts: true,
        }),
      );
      expect(await checks('restricted')).toEqual({
        attachments: 'allowed',
        shareLinks: 'allowed',
        temporaryChat: 'allowed',
        webSearch: 'allowed',
        branching: 'allowed',
        projects: 'allowed',
        memory: 'allowed',
        artifacts: 'allowed',
        accountDeletion: 403,
      });
    });

    it('still requires the instance switch when the role allows a feature', async () => {
      await updateSetting('features', { ...ALL_ON, branching: false, temporaryChat: false });
      expect(await branchingStatus('user')).toBe(403);
      await expect(assertTemporaryChatAllowed('user')).rejects.toMatchObject({ status: 422 });
      const me = await json<{ features: Record<string, boolean> }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(me.features).toMatchObject({ branching: false, temporaryChat: false });
    });
  });

  describe('deleting your own account (v0.10)', () => {
    it('is off for every role until switched on, and follows its switch per role', async () => {
      for (const role of ['admin', 'auditor', 'user', 'restricted'] as const) {
        expect(DEFAULT_ROLE_FEATURES[role].accountDeletion).toBe(false);
        const me = await json<{ features: Record<string, boolean> }>(
          await call(actors[role], 'GET', '/me'),
        );
        expect(me.features.accountDeletion).toBe(false);
      }
      await expect(assertRoleFeature('user', 'accountDeletion')).rejects.toMatchObject({
        status: 403,
        message:
          'Deleting your own account is not available for your role. Ask your administrator.',
      });

      const body = await json<{ roleFeatures: Record<string, unknown> }>(
        await putRole('user', { accountDeletion: true }),
      );
      expect(body.roleFeatures.accountDeletion).toBe(true);
      expect((await checks('user')).accountDeletion).toBe('allowed');
      const me = await json<{ features: Record<string, boolean> }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(me.features.accountDeletion).toBe(true);
      // No instance-wide switch: the instance features do not narrow it.
      await updateSetting('features', {});
      expect((await checks('user')).accountDeletion).toBe('allowed');
      // Other roles keep their own value.
      expect((await checks('restricted')).accountDeletion).toBe(403);

      const summary = rolesAccessSchema.parse(
        await json(await call(actors.admin, 'GET', '/admin/roles')),
      );
      const user = summary.roles.find((entry) => entry.role === 'user')!;
      expect(user.roleFeatures.accountDeletion).toBe(true);
      expect(user.features.accountDeletion).toBe(true);

      expect(
        (await call(actors.auditor, 'PUT', '/admin/roles/user', { accountDeletion: false })).status,
      ).toBe(403);
      await json(await putRole('user', { accountDeletion: false }));
      expect((await checks('user')).accountDeletion).toBe(403);
    });
  });

  describe('web search', () => {
    it('is refused server-side when the role may not search', async () => {
      await json(await putRole('user', { webSearch: false }));
      const thread = await threadFor('user');

      await expect(
        resolveTurnContext(actors.user, turnInput(thread.id, { webSearch: true })),
      ).rejects.toMatchObject({
        status: 403,
        message: 'Web search is not available for your role',
      });
      // The same person can still chat without searching.
      await expect(
        resolveTurnContext(actors.user, turnInput(thread.id, { webSearch: false })),
      ).resolves.toMatchObject({ thread: { id: thread.id } });
    });

    it('is not advertised when the role allows it but no provider can run', async () => {
      await updateSetting('search', { enabled: false });
      const me = await json<{ features: Record<string, boolean> }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(me.features.webSearch).toBe(false);
    });
  });
});
