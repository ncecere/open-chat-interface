import {
  type CatalogModel,
  DEFAULT_ROLE_FEATURES,
  type RoleFeatureKey,
  rolesAccessSchema,
  type SendMessageInput,
  type UserRole,
} from '@oci/shared';
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

const { and, desc, eq, schema } = await import('@oci/db');
const { rolesRoutes } = await import('../../routes/admin/roles.js');
const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { meRoutes } = await import('../../routes/me.js');
const { modelCatalogRoutes } = await import('../../routes/models.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { assertAttachmentUseAllowed } = await import('../../services/attachments/index.js');
const { assertArtifactsAllowed } = await import('../../services/artifacts/store.js');
const { assertShareLinkManagementAllowed } = await import('../../services/share-links.js');
const { assertTemporaryChatAllowed, createThread } = await import('../../services/threads.js');
const { assertProjectsAllowed } = await import('../../services/projects.js');
const { resolveTurnContext } = await import('../../services/chat/turn-context.js');
const { assertMemoryAvailable } = await import('../../services/memory/store.js');
const { assertRoleFeature } = await import('../../services/role-features.js');

type Actor = AuthenticatedUser;

const ALL_ON = {
  shareLinks: true,
  temporaryChat: true,
  webSearch: true,
  attachments: true,
  branching: true,
  memory: true,
};

function appFor(actor: Actor) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', actor);
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/roles', rolesRoutes);
  app.route('/admin/settings', settingsRoutes);
  app.route('/me', meRoutes);
  app.route('/models', modelCatalogRoutes);
  app.route('/threads', threadRoutes);
  return app;
}

async function call(actor: Actor, method: string, path: string, body?: unknown) {
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

/** Runs one check and reports how it ended, so cases compare compactly. */
async function outcome(check: () => Promise<unknown>): Promise<'allowed' | number> {
  try {
    await check();
    return 'allowed';
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== 'number') throw error;
    return status;
  }
}

describe.skipIf(!available)('live: feature entitlements per role', () => {
  let live: LiveDatabase;
  const actors = {} as Record<UserRole, Actor>;

  async function threadFor(role: UserRole) {
    return createThread({
      userId: actors[role].id,
      organizationId: state.organizationId,
      role,
    });
  }

  function turnInput(threadId: string, overrides: Partial<SendMessageInput> = {}) {
    return {
      threadId,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      modelSlug: 'thinker',
      webSearch: false,
      attachmentIds: [],
      temporary: false,
      trigger: 'submit-message',
      ...overrides,
    } as SendMessageInput;
  }

  async function putRole(role: UserRole, body: unknown, actor = actors.admin) {
    return call(actor, 'PUT', `/admin/roles/${role}`, body);
  }

  /** Whether the forks route lets the role past the branching check. */
  async function branchingStatus(role: UserRole): Promise<number> {
    const thread = await threadFor(role);
    // An empty body fails validation (422) only after the branching check.
    const response = await call(actors[role], 'POST', `/threads/${thread.id}/forks`, {});
    return response.status;
  }

  async function checks(role: UserRole): Promise<Record<RoleFeatureKey, 'allowed' | number>> {
    const thread = await threadFor(role);
    return {
      attachments: await outcome(() => assertAttachmentUseAllowed(role)),
      shareLinks: await outcome(() => assertShareLinkManagementAllowed(role)),
      temporaryChat: await outcome(() => assertTemporaryChatAllowed(role)),
      webSearch: await outcome(() =>
        resolveTurnContext(actors[role], turnInput(thread.id, { webSearch: true })),
      ),
      branching: (await branchingStatus(role)) === 403 ? 403 : 'allowed',
      projects: await outcome(() => assertProjectsAllowed(role)),
      memory: await outcome(() => assertMemoryAvailable(role)),
      artifacts: await outcome(() => assertArtifactsAllowed(role)),
      accountDeletion: await outcome(() => assertRoleFeature(role, 'accountDeletion')),
    };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('role_features');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();

    for (const role of ['admin', 'auditor', 'user', 'restricted'] as const) {
      const id = await seedUser(live.db, state.organizationId, {
        role,
        email: `${role}@roles.test`,
      });
      actors[role] = {
        id,
        role,
        name: `${role} person`,
        email: `${role}@roles.test`,
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      };
    }

    const [provider] = await live.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai-compatible',
        label: 'Never called',
        baseUrl: 'http://127.0.0.1:9/v1',
      })
      .returning();
    await live.db.insert(schema.model).values([
      {
        organizationId: state.organizationId,
        providerId: provider!.id,
        slug: 'thinker',
        upstreamModelId: 'thinker',
        displayName: 'Thinker',
        capabilities: ['effort_control'],
        supportedEfforts: ['instant', 'low', 'high'],
        visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
        isDefault: true,
      },
      {
        organizationId: state.organizationId,
        providerId: provider!.id,
        slug: 'deep-only',
        upstreamModelId: 'deep-only',
        displayName: 'Deep only',
        capabilities: ['effort_control', 'vision'],
        supportedEfforts: ['high'],
        visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
      },
    ]);
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

  describe('reasoning levels', () => {
    async function catalog(role: UserRole) {
      const body = await json<{ models: CatalogModel[] }>(
        await call(actors[role], 'GET', '/models'),
      );
      return Object.fromEntries(body.models.map((model) => [model.slug, model]));
    }

    it('intersects model levels with the role in /models and chat validation', async () => {
      expect((await catalog('restricted')).thinker?.supportedEfforts).toEqual([
        'instant',
        'low',
        'high',
      ]);

      await json(await putRole('restricted', { reasoningEfforts: ['instant', 'low'] }));

      const restricted = await catalog('restricted');
      expect(restricted.thinker?.supportedEfforts).toEqual(['instant', 'low']);
      // No level left: effort control is withdrawn rather than read as "all".
      expect(restricted['deep-only']).toMatchObject({
        supportedEfforts: [],
        capabilities: ['vision'],
      });
      expect((await catalog('user')).thinker?.supportedEfforts).toEqual(['instant', 'low', 'high']);

      const thread = await threadFor('restricted');
      await expect(
        resolveTurnContext(actors.restricted, turnInput(thread.id, { effort: 'high' })),
      ).rejects.toMatchObject({
        status: 403,
        message: 'Reasoning effort "high" is not available for your role',
      });
      await expect(
        resolveTurnContext(actors.restricted, turnInput(thread.id, { effort: 'low' })),
      ).resolves.toMatchObject({ resolved: { supportedEfforts: ['instant', 'low'] } });
      // A model limit is still reported as one.
      await expect(
        resolveTurnContext(
          actors.restricted,
          turnInput(thread.id, { modelSlug: 'deep-only', effort: 'instant' }),
        ),
      ).rejects.toMatchObject({ status: 422 });

      const userThread = await threadFor('user');
      await expect(
        resolveTurnContext(actors.user, turnInput(userThread.id, { effort: 'high' })),
      ).resolves.toBeDefined();
    });

    it('exposes and partially updates the default reasoning level', async () => {
      const before = await json<{ chat: { defaultEffort: string } }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(before.chat.defaultEffort).toBe('instant');

      expect(
        (await call(actors.admin, 'PATCH', '/admin/settings', { defaultEffort: 'low' })).status,
      ).toBe(200);
      // A later write of another chat field must not reset it to the default.
      expect(
        (await call(actors.admin, 'PATCH', '/admin/settings', { defaultSystemPrompt: 'Be brief.' }))
          .status,
      ).toBe(200);

      const settings = await json<{ defaultEffort: string; defaultSystemPrompt: string }>(
        await call(actors.admin, 'GET', '/admin/settings'),
      );
      expect(settings).toMatchObject({ defaultEffort: 'low', defaultSystemPrompt: 'Be brief.' });
      const after = await json<{ chat: { defaultEffort: string } }>(
        await call(actors.user, 'GET', '/me'),
      );
      expect(after.chat.defaultEffort).toBe('low');

      expect(
        (await call(actors.admin, 'PATCH', '/admin/settings', { defaultEffort: 'extreme' })).status,
      ).toBe(422);
      expect(
        (await call(actors.auditor, 'PATCH', '/admin/settings', { defaultEffort: 'high' })).status,
      ).toBe(403);
    });
  });

  describe('PUT /admin/roles/:role', () => {
    it('changes only the sent fields and records an audit entry', async () => {
      await json(await putRole('user', { webSearch: false }));
      const body = await json<{ roleFeatures: Record<string, unknown> }>(
        await putRole('user', { branching: false, reasoningEfforts: ['high', 'instant'] }),
      );
      expect(body.roleFeatures).toEqual({
        ...DEFAULT_ROLE_FEATURES.user,
        webSearch: false,
        branching: false,
        reasoningEfforts: ['instant', 'high'],
      });

      const [entry] = await live.db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'role.features.update'),
            eq(schema.auditLog.targetId, 'user'),
          ),
        )
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(1);
      expect(entry).toMatchObject({
        actorUserId: actors.admin.id,
        targetType: 'role',
        metadata: {
          keys: ['branching', 'reasoningEfforts'],
          changes: [
            { key: 'branching', before: true, after: false },
            {
              key: 'reasoningEfforts',
              before: ['instant', 'low', 'medium', 'high'],
              after: ['instant', 'high'],
            },
          ],
        },
      });
    });

    it.each([
      ['an empty body', {}],
      ['an unknown field', { personas: true }],
      ['a non-boolean switch', { attachments: 'yes' }],
      ['levels without instant', { reasoningEfforts: ['low'] }],
      ['repeated levels', { reasoningEfforts: ['instant', 'low', 'low'] }],
      ['an unknown level', { reasoningEfforts: ['instant', 'max'] }],
    ])('rejects %s', async (_label, body) => {
      const response = await putRole('user', body);
      expect(response.status).toBe(422);
      const summary = rolesAccessSchema.parse(
        await json(await call(actors.admin, 'GET', '/admin/roles')),
      );
      expect(summary.roles.find((entry) => entry.role === 'user')?.roleFeatures).toEqual(
        DEFAULT_ROLE_FEATURES.user,
      );
    });

    it('rejects an unknown role', async () => {
      expect((await putRole('owner' as UserRole, { webSearch: false })).status).toBe(404);
    });

    it('lets an auditor read role access but not change it', async () => {
      expect((await call(actors.auditor, 'GET', '/admin/roles')).status).toBe(200);
      const response = await putRole('user', { webSearch: false }, actors.auditor);
      expect(response.status).toBe(403);
      expect((await checks('user')).webSearch).toBe('allowed');
    });
  });
});
