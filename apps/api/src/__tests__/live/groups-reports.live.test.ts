import { schema } from '@oci/db';
import type { GroupUsage, RolesAccess } from '@oci/shared';
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

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!available)('live: groups in the roles summary, the usage card and /api/me', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let admin: Actor;
  let auditor: Actor;
  let manager: Actor;

  async function use(actor: Actor, messages: number, cost: number, daysAgo = 1) {
    await live.db.insert(schema.usageEvent).values({
      organizationId,
      userId: actor.id,
      modelSlug: 'm1',
      messageCount: messages,
      tokensIn: messages * 10,
      tokensOut: messages * 5,
      costMicros: cost,
      pending: false,
      occurredAt: new Date(Date.now() - daysAgo * DAY),
    });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('groups_reports');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    admin = await person(live.db, organizationId, { role: 'admin' });
    auditor = await person(live.db, organizationId, { role: 'auditor' });
    manager = await person(live.db, organizationId, { role: 'user' });
  });

  afterAll(async () => {
    await live.destroy();
  });

  describe('Roles & access: a read-only Groups section', () => {
    it('lists each group with its members, budgets and models, and leaves the per-role counts role-only', async () => {
      const group = await groupNamed(live.db, organizationId, 'Physics');
      const empty = await groupNamed(live.db, organizationId, 'Astronomy');
      const m1 = await person(live.db, organizationId);
      await addMember(live.db, group.id, m1.id);
      await addMember(live.db, group.id, manager.id, 'manager');
      const [policy] = await live.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId,
          name: 'Physics budget',
          metric: 'messages',
          limitValue: 5,
          windowKind: 'rolling',
          windowHours: 24,
        })
        .returning();
      const [provider] = await live.db
        .insert(schema.provider)
        .values({ organizationId, kind: 'openai', label: 'No calls' })
        .returning();
      const [hidden] = await live.db
        .insert(schema.model)
        .values({
          organizationId,
          providerId: provider!.id,
          slug: 'm1',
          upstreamModelId: 'm1',
          displayName: 'Model one',
          visibleToRoles: [],
        })
        .returning();
      await live.db
        .insert(schema.quotaPolicyGroup)
        .values({ policyId: policy!.id, groupId: group.id });
      await live.db
        .insert(schema.modelGroupAccess)
        .values({ modelId: hidden!.id, groupId: group.id });

      for (const actor of [admin, auditor]) {
        const body = await json<RolesAccess>(await call(actor, 'GET', '/admin/roles'));
        expect(body.groups).toEqual([
          {
            id: empty.id,
            name: 'Astronomy',
            memberCount: 0,
            managerCount: 0,
            budgets: [],
            models: [],
          },
          {
            id: group.id,
            name: 'Physics',
            memberCount: 2,
            managerCount: 1,
            budgets: [{ id: policy!.id, name: 'Physics budget', enabled: true }],
            models: [{ id: hidden!.id, displayName: 'Model one', enabled: true }],
          },
        ]);
        // The model is hidden from every role, and the per-role counts say so.
        for (const role of body.roles) expect(role.models.visible).toBe(0);
        // The role's own budgets are not the group's.
        for (const role of body.roles) expect(role.budgets).toEqual([]);
      }
      // Only administrators and auditors read it.
      expect((await call(manager, 'GET', '/admin/roles')).status).toBe(403);
    });
  });

  describe('usage by the current members, last N days', () => {
    let group: { id: string };
    let ann: Actor;
    let bob: Actor;
    let outsider: Actor;

    beforeAll(async () => {
      group = await groupNamed(live.db, organizationId, 'Usage');
      ann = await person(live.db, organizationId, { name: 'Ann Heavy' });
      bob = await person(live.db, organizationId, { name: 'Bob Light' });
      outsider = await person(live.db, organizationId, { name: 'Out Sider' });
      const idle = await person(live.db, organizationId, { name: 'Ivy Idle' });
      for (const member of [ann, bob, idle]) await addMember(live.db, group.id, member.id);
      await use(ann, 10, 500, 1);
      await use(ann, 4, 200, 20);
      await use(bob, 3, 50, 2);
      await use(outsider, 99, 9_999, 1);
    });

    it('sums the members’ usage over the window, ranks people, and ignores everyone else', async () => {
      const week = await json<GroupUsage>(
        await call(admin, 'GET', `/admin/groups/${group.id}/usage?days=7`),
      );
      expect(week.days).toBe(7);
      expect(week.memberCount).toBe(3);
      expect(week.totals).toEqual({ messages: 13, tokensIn: 130, tokensOut: 65, costMicros: 550 });
      expect(week.people.map((p) => [p.name, p.messages, p.costMicros])).toEqual([
        ['Ann Heavy', 10, 500],
        ['Bob Light', 3, 50],
      ]);
      expect(week.people[0]).toMatchObject({ email: ann.email, tokensIn: 100, tokensOut: 50 });
      expect(week.truncated).toBe(false);

      const month = await json<GroupUsage>(
        await call(auditor, 'GET', `/admin/groups/${group.id}/usage`),
      );
      expect(month.days).toBe(30);
      expect(month.totals.messages).toBe(17);
    });

    it('is the same from the rollups as from the events', async () => {
      const { groupUsage } = await import('../../services/groups/usage.js');
      const now = new Date();
      const events = await groupUsage(group.id, 30, { source: 'events', now });
      const rollups = await groupUsage(group.id, 30, { source: 'rollups', now });
      expect(rollups).toEqual(events);
      expect(events.totals.messages).toBe(17);
    });

    it('follows membership: someone who left is not counted, someone who joined is, with their history', async () => {
      const g = await groupNamed(live.db, organizationId, 'Usage moves');
      await addMember(live.db, g.id, ann.id);
      expect(
        (await json<GroupUsage>(await call(admin, 'GET', `/admin/groups/${g.id}/usage`))).totals
          .messages,
      ).toBe(14);
      await addMember(live.db, g.id, bob.id);
      expect(
        (await json<GroupUsage>(await call(admin, 'GET', `/admin/groups/${g.id}/usage`))).totals
          .messages,
      ).toBe(17);
    });

    it('refuses a window that is not 1 to 90 days, a manager, and an unknown group', async () => {
      expect((await call(admin, 'GET', `/admin/groups/${group.id}/usage?days=0`)).status).toBe(422);
      expect((await call(admin, 'GET', `/admin/groups/${group.id}/usage?days=91`)).status).toBe(
        422,
      );
      expect((await call(manager, 'GET', `/admin/groups/${group.id}/usage`)).status).toBe(403);
      expect((await call(admin, 'GET', '/admin/groups/nope/usage')).status).toBe(404);
    });
  });

  describe('GET /api/me tells a manager they manage something', () => {
    it('counts the groups a person manages, so the Settings tab shows only for managers', async () => {
      const first = await groupNamed(live.db, organizationId, 'Managed one');
      const second = await groupNamed(live.db, organizationId, 'Managed two');
      const plain = await person(live.db, organizationId);
      const both = await person(live.db, organizationId);
      await addMember(live.db, first.id, plain.id);
      await addMember(live.db, first.id, both.id, 'manager');
      await addMember(live.db, second.id, both.id, 'manager');

      const summary = async (actor: Actor) =>
        (
          await json<{ settingsSummary: { managedGroups: number } }>(
            await call(actor, 'GET', '/me'),
          )
        ).settingsSummary.managedGroups;
      expect(await summary(plain)).toBe(0);
      expect(await summary(both)).toBe(2);
      expect(await summary(admin)).toBe(0);
    });
  });
});
