import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import {
  call,
  errorOf,
  json,
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
 * This suite covers Settings → Models: personal defaults; the shared helpers live in
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
    live = await createLiveDatabase('personal_settings_models');
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

  const { person } = personalSettingsHelpers(state, () => live.db);

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
});
