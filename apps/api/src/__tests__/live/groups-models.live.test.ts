import { eq, schema } from '@oci/db';
import type { CatalogModel, UserRole } from '@oci/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Actor,
  addMember,
  call,
  groupNamed,
  json,
  person,
} from '../../../test/groups.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

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
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));

const { listAvailableModels, resolveModelForRole } = await import('../../services/models.js');

/**
 * Model visibility with groups (v0.14, #394): a model is visible to a person if
 * their role is in `visibleToRoles` OR any group they are in is granted it; a
 * disabled model or provider stays unavailable. A group only ever ADDS.
 */
describe.skipIf(!available)('live: models granted to groups', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let providerId: string;
  let disabledProviderId: string;
  const models: Record<string, string> = {};

  const viewer = (actor: Actor) => ({ userId: actor.id, role: actor.role });
  const slugs = async (actor: Actor) =>
    (await listAvailableModels(viewer(actor))).map((model) => model.slug).sort();
  const resolves = async (actor: Actor, slug: string) => {
    try {
      await resolveModelForRole(slug, viewer(actor));
      return 'allowed';
    } catch (error) {
      return (error as { status?: number }).status ?? 'error';
    }
  };

  async function addModel(
    slug: string,
    options: { roles: UserRole[]; enabled?: boolean; provider?: string } = { roles: [] },
  ) {
    const [row] = await live.db
      .insert(schema.model)
      .values({
        organizationId,
        providerId: options.provider ?? providerId,
        slug,
        upstreamModelId: slug,
        displayName: slug,
        visibleToRoles: options.roles,
        enabled: options.enabled ?? true,
      })
      .returning();
    models[slug] = row!.id;
  }

  async function grant(groupId: string, ...modelSlugs: string[]) {
    for (const slug of modelSlugs) {
      await live.db.insert(schema.modelGroupAccess).values({ groupId, modelId: models[slug]! });
    }
  }

  beforeAll(async () => {
    live = await createLiveDatabase('groups_models');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    const providers = await live.db
      .insert(schema.provider)
      .values([
        {
          organizationId,
          kind: 'openai-compatible',
          label: 'Never called',
          baseUrl: 'http://127.0.0.1:9',
        },
        {
          organizationId,
          kind: 'openai-compatible',
          label: 'Switched off',
          baseUrl: 'http://127.0.0.1:9',
          enabled: false,
        },
      ])
      .returning();
    providerId = providers[0]!.id;
    disabledProviderId = providers[1]!.id;
    await addModel('for-users', { roles: ['user', 'admin'] });
    await addModel('for-admins', { roles: ['admin'] });
    await addModel('hidden-a', { roles: [] });
    await addModel('hidden-b', { roles: [] });
    await addModel('hidden-off', { roles: [], enabled: false });
    await addModel('hidden-on-off-provider', { roles: [], provider: disabledProviderId });
  });

  afterAll(async () => {
    await live.destroy();
  });

  it('shows a person exactly their role’s models when they are in no group', async () => {
    const user = await person(live.db, organizationId, { role: 'user' });
    expect(await slugs(user)).toEqual(['for-users']);
    expect(await resolves(user, 'for-users')).toBe('allowed');
    expect(await resolves(user, 'hidden-a')).toBe(403);
    expect(await resolves(user, 'for-admins')).toBe(403);
    expect(await resolves(user, 'no-such-model')).toBe(404);
  });

  it('adds the models of a group the person is in, and offers them to no one else', async () => {
    const group = await groupNamed(live.db, organizationId, 'Research');
    await grant(group.id, 'hidden-a');
    const member = await person(live.db, organizationId, { role: 'user' });
    const outsider = await person(live.db, organizationId, { role: 'user' });
    await addMember(live.db, group.id, member.id);

    expect(await slugs(member)).toEqual(['for-users', 'hidden-a']);
    expect(await resolves(member, 'hidden-a')).toBe('allowed');
    expect(await resolves(member, 'hidden-b')).toBe(403);
    expect(await slugs(outsider)).toEqual(['for-users']);
    expect(await resolves(outsider, 'hidden-a')).toBe(403);
  });

  it('works for a restricted person, and for a manager as for a member', async () => {
    const group = await groupNamed(live.db, organizationId, 'Restricted access');
    await grant(group.id, 'hidden-b');
    const restricted = await person(live.db, organizationId, { role: 'restricted' });
    const manager = await person(live.db, organizationId, { role: 'user' });
    await addMember(live.db, group.id, restricted.id);
    await addMember(live.db, group.id, manager.id, 'manager');
    expect(await slugs(restricted)).toEqual(['hidden-b']);
    expect(await resolves(restricted, 'hidden-b')).toBe('allowed');
    expect(await slugs(manager)).toContain('hidden-b');
  });

  it('lists a model once when the role and a group both grant it', async () => {
    const group = await groupNamed(live.db, organizationId, 'Both ways');
    await grant(group.id, 'for-users');
    const member = await person(live.db, organizationId, { role: 'user' });
    await addMember(live.db, group.id, member.id);
    expect(await slugs(member)).toEqual(['for-users']);
    expect(await resolves(member, 'for-users')).toBe('allowed');
  });

  it('adds up the grants of several groups', async () => {
    const one = await groupNamed(live.db, organizationId, 'Union one');
    const two = await groupNamed(live.db, organizationId, 'Union two');
    await grant(one.id, 'hidden-a');
    await grant(two.id, 'hidden-b', 'hidden-a');
    const member = await person(live.db, organizationId, { role: 'user' });
    await addMember(live.db, one.id, member.id);
    await addMember(live.db, two.id, member.id);
    expect(await slugs(member)).toEqual(['for-users', 'hidden-a', 'hidden-b']);
  });

  it('keeps a disabled model and a model on a disabled provider unavailable, even to a group', async () => {
    const group = await groupNamed(live.db, organizationId, 'Disabled things');
    await grant(group.id, 'hidden-off', 'hidden-on-off-provider');
    const member = await person(live.db, organizationId, { role: 'user' });
    await addMember(live.db, group.id, member.id);
    expect(await slugs(member)).toEqual(['for-users']);
    expect(await resolves(member, 'hidden-off')).toBe(403);
    expect(await resolves(member, 'hidden-on-off-provider')).toBe(403);
  });

  it('never removes an access: every role keeps its models whatever groups it is in', async () => {
    const empty = await groupNamed(live.db, organizationId, 'Grants nothing');
    const narrow = await groupNamed(live.db, organizationId, 'Grants one');
    await grant(narrow.id, 'hidden-a');
    for (const role of ['admin', 'auditor', 'user', 'restricted'] as UserRole[]) {
      const alone = await person(live.db, organizationId, { role });
      const inEmpty = await person(live.db, organizationId, { role });
      const inNarrow = await person(live.db, organizationId, { role });
      const inBoth = await person(live.db, organizationId, { role });
      await addMember(live.db, empty.id, inEmpty.id);
      await addMember(live.db, narrow.id, inNarrow.id);
      await addMember(live.db, empty.id, inBoth.id);
      await addMember(live.db, narrow.id, inBoth.id, 'manager');

      const base = await slugs(alone);
      expect(await slugs(inEmpty), `${role} in an empty group`).toEqual(base);
      for (const other of [inNarrow, inBoth]) {
        const withGroup = await slugs(other);
        for (const slug of base) expect(withGroup, `${role} keeps ${slug}`).toContain(slug);
        expect(withGroup).toContain('hidden-a');
      }
      for (const slug of base) expect(await resolves(inBoth, slug)).toBe('allowed');
    }
  });

  it('takes the extra models away the moment a member is removed, and gives them back when added', async () => {
    const group = await groupNamed(live.db, organizationId, 'Come and go');
    await grant(group.id, 'hidden-a');
    const member = await person(live.db, organizationId, { role: 'user' });
    expect(await slugs(member)).toEqual(['for-users']);
    await addMember(live.db, group.id, member.id);
    expect(await slugs(member)).toEqual(['for-users', 'hidden-a']);
    expect(await resolves(member, 'hidden-a')).toBe('allowed');

    await live.db.delete(schema.groupMember).where(eq(schema.groupMember.userId, member.id));
    expect(await slugs(member)).toEqual(['for-users']);
    expect(await resolves(member, 'hidden-a')).toBe(403);

    await addMember(live.db, group.id, member.id);
    expect(await resolves(member, 'hidden-a')).toBe('allowed');
    // Withdrawing the grant, or deleting the group, does the same.
    await live.db
      .delete(schema.modelGroupAccess)
      .where(eq(schema.modelGroupAccess.groupId, group.id));
    expect(await resolves(member, 'hidden-a')).toBe(403);
    await grant(group.id, 'hidden-a');
    expect(await resolves(member, 'hidden-a')).toBe('allowed');
    await live.db.delete(schema.group).where(eq(schema.group.id, group.id));
    expect(await resolves(member, 'hidden-a')).toBe(403);
  });

  describe('through the routes people use', () => {
    it('lists the group’s models in the model picker, and says an empty list is not the role’s doing', async () => {
      const group = await groupNamed(live.db, organizationId, 'Picker');
      await grant(group.id, 'hidden-a');
      const member = await person(live.db, organizationId, { role: 'restricted' });
      const outsider = await person(live.db, organizationId, { role: 'restricted' });
      await addMember(live.db, group.id, member.id);

      const mine = await json<{ models: CatalogModel[]; hiddenFromRole: boolean }>(
        await call(member, 'GET', '/models'),
      );
      expect(mine.models.map((m) => m.slug)).toEqual(['hidden-a']);
      expect(mine.hiddenFromRole).toBe(false);
      const theirs = await json<{ models: CatalogModel[]; hiddenFromRole: boolean }>(
        await call(outsider, 'GET', '/models'),
      );
      expect(theirs.models).toEqual([]);
      expect(theirs.hiddenFromRole).toBe(true);
    });

    it('lets a member save a group model as their default, and a non-member not', async () => {
      const group = await groupNamed(live.db, organizationId, 'Defaults');
      await grant(group.id, 'hidden-b');
      const member = await person(live.db, organizationId, { role: 'user' });
      const outsider = await person(live.db, organizationId, { role: 'user' });
      await addMember(live.db, group.id, member.id);
      expect(
        (await call(member, 'PATCH', '/me/preferences', { defaultModelSlug: 'hidden-b' })).status,
      ).toBe(200);
      expect(
        (await call(outsider, 'PATCH', '/me/preferences', { defaultModelSlug: 'hidden-b' })).status,
      ).toBe(422);

      const me = await json<{ chat: { defaultModelSlug: string | null } }>(
        await call(member, 'GET', '/me'),
      );
      expect(me.chat.defaultModelSlug).toBe('hidden-b');
      // Removed from the group: the saved default is ignored from the next request.
      await live.db.delete(schema.groupMember).where(eq(schema.groupMember.userId, member.id));
      const after = await json<{ chat: { defaultModelSlug: string | null } }>(
        await call(member, 'GET', '/me'),
      );
      expect(after.chat.defaultModelSlug).toBeNull();
    });
  });
});
