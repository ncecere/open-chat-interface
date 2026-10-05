import {
  type CatalogModel,
  DEFAULT_ROLE_FEATURES,
  rolesAccessSchema,
  type UserRole,
} from '@oci/shared';
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
 * reasoning levels and PUT /admin/roles/:role; the shared fixtures live in test/role-features.fixtures.ts.
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

const { and, desc, eq, schema } = await import('@oci/db');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { resolveTurnContext } = await import('../../services/chat/turn-context.js');

describe.skipIf(!available)('live: feature entitlements per role', () => {
  let live: LiveDatabase;
  const actors = {} as Record<UserRole, Actor>;

  const { checks, putRole, threadFor, turnInput } = roleFeatureHelpers(state, actors);

  beforeAll(async () => {
    live = await createLiveDatabase('role_features_admin');
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
