import { eq, schema, sql } from '@oci/db';
import {
  type AddGroupMembersResult,
  type GroupMembersPage,
  MAX_GROUPS_PER_PERSON,
  MAX_MEMBERS_PER_GROUP,
  type ManagedGroup,
  type MyGroup,
  PERSON_LOOKUPS_PER_MINUTE,
} from '@oci/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Actor,
  addMember,
  call,
  groupNamed,
  json,
  person,
  refusal,
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

describe.skipIf(!available)('live: delegated group managers', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let group: { id: string };
  let other: { id: string };
  let manager: Actor;
  let anotherManager: Actor;
  let member: Actor;
  let managerOfOther: Actor;
  let outsider: Actor;
  let admin: Actor;
  let auditor: Actor;
  let candidate: Actor;

  const members = async (id: string) =>
    (await live.db.select().from(schema.groupMember).where(eq(schema.groupMember.groupId, id)))
      .map((row) => `${row.userId}:${row.role}`)
      .sort();

  beforeAll(async () => {
    live = await createLiveDatabase('groups_managers');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    group = await groupNamed(live.db, organizationId, 'Physics');
    other = await groupNamed(live.db, organizationId, 'History');
    manager = await person(live.db, organizationId, { name: 'Mia Manager' });
    anotherManager = await person(live.db, organizationId, { name: 'Max Manager' });
    member = await person(live.db, organizationId, { name: 'Mo Member' });
    managerOfOther = await person(live.db, organizationId, { name: 'Hal Historian' });
    outsider = await person(live.db, organizationId, { name: 'Olly Outsider' });
    admin = await person(live.db, organizationId, { role: 'admin' });
    auditor = await person(live.db, organizationId, { role: 'auditor' });
    candidate = await person(live.db, organizationId, { name: 'Cal Candidate' });
    await addMember(live.db, group.id, manager.id, 'manager');
    await addMember(live.db, group.id, anotherManager.id, 'manager');
    await addMember(live.db, group.id, member.id);
    await addMember(live.db, other.id, managerOfOther.id, 'manager');
  });

  afterAll(async () => {
    await live.destroy();
  });

  describe('what a person sees of their own groups', () => {
    it('lists the groups they are in, with their role, and nothing for a person in none', async () => {
      const mine = await json<{ groups: MyGroup[] }>(await call(member, 'GET', '/groups/mine'));
      expect(mine.groups).toEqual([{ id: group.id, name: 'Physics', role: 'member' }]);
      const asManager = await json<{ groups: MyGroup[] }>(
        await call(manager, 'GET', '/groups/mine'),
      );
      expect(asManager.groups).toEqual([{ id: group.id, name: 'Physics', role: 'manager' }]);
      expect(
        (await json<{ groups: MyGroup[] }>(await call(outsider, 'GET', '/groups/mine'))).groups,
      ).toEqual([]);
      expect((await call(null, 'GET', '/groups/mine')).status).toBe(401);
    });

    it('lists only the groups a person manages, with counts and the member cap', async () => {
      const managed = await json<{ groups: ManagedGroup[] }>(
        await call(manager, 'GET', '/groups/managed'),
      );
      expect(managed.groups).toEqual([
        {
          id: group.id,
          name: 'Physics',
          description: null,
          memberCount: 3,
          managerCount: 2,
          memberLimit: MAX_MEMBERS_PER_GROUP,
        },
      ]);
      for (const actor of [member, outsider, admin, auditor]) {
        expect(
          (await json<{ groups: ManagedGroup[] }>(await call(actor, 'GET', '/groups/managed')))
            .groups,
        ).toEqual([]);
      }
    });
  });

  describe('who gets which answer on a managed group', () => {
    const calls = (id: string, target: Actor) =>
      [
        ['GET', `/groups/managed/${id}/members`, undefined],
        ['POST', `/groups/managed/${id}/members`, { emails: [target.email] }],
        ['DELETE', `/groups/managed/${id}/members/${target.id}`, undefined],
      ] as const;

    it('answers 404 to a person who is in no group and manages nothing, administrators and auditors included', async () => {
      // No relation to the group, and manages nothing: the group is not there.
      for (const actor of [outsider, admin, auditor]) {
        for (const [method, path, body] of calls(group.id, candidate)) {
          expect(
            (await call(actor, method, path, body)).status,
            `${actor.name} ${method} ${path}`,
          ).toBe(404);
        }
        for (const [method, path, body] of calls('no-such-group', candidate)) {
          expect((await call(actor, method, path, body)).status).toBe(404);
        }
      }
    });

    it('answers 403 to a member who is not a manager', async () => {
      for (const [method, path, body] of calls(group.id, candidate)) {
        expect((await call(member, method, path, body)).status, `${method} ${path}`).toBe(403);
      }
    });

    it('answers 403 to a manager of another group, whether or not the group exists', async () => {
      for (const id of [group.id, 'no-such-group']) {
        for (const [method, path, body] of calls(id, candidate)) {
          expect((await call(managerOfOther, method, path, body)).status, `${method} ${path}`).toBe(
            403,
          );
        }
      }
      expect(await members(group.id)).not.toContain(`${candidate.id}:member`);
    });

    it('answers 401 without a session', async () => {
      expect((await call(null, 'GET', `/groups/managed/${group.id}/members`)).status).toBe(401);
    });

    it('gives a manager no way to see grants or usage, or to use the admin routes', async () => {
      expect((await call(manager, 'GET', `/groups/managed/${group.id}/grants`)).status).toBe(404);
      expect((await call(manager, 'GET', `/groups/managed/${group.id}/usage`)).status).toBe(404);
      expect((await call(manager, 'GET', `/groups/managed/${group.id}`)).status).toBe(404);
      for (const path of [
        '/admin/groups',
        `/admin/groups/${group.id}`,
        `/admin/groups/${group.id}/members`,
        `/admin/groups/${group.id}/grants`,
      ]) {
        expect((await call(manager, 'GET', path)).status, path).toBe(403);
      }
    });
  });

  describe('what a manager does', () => {
    it('sees the member list with names, emails and roles, searchable and paged', async () => {
      const page = await json<GroupMembersPage>(
        await call(manager, 'GET', `/groups/managed/${group.id}/members`),
      );
      expect(page.total).toBe(3);
      expect(page.members.map((m) => `${m.name}:${m.role}`)).toEqual([
        'Max Manager:manager',
        'Mia Manager:manager',
        'Mo Member:member',
      ]);
      expect(Object.keys(page.members[0]!).sort()).toEqual(
        ['addedAt', 'email', 'name', 'role', 'userId'].sort(),
      );
      const found = await json<GroupMembersPage>(
        await call(
          manager,
          'GET',
          `/groups/managed/${group.id}/members?search=${member.email.toUpperCase()}`,
        ),
      );
      expect(found.members.map((m) => m.userId)).toEqual([member.id]);
    });

    it('adds members only, by email, and cannot make a manager', async () => {
      const result = await json<AddGroupMembersResult>(
        await call(manager, 'POST', `/groups/managed/${group.id}/members`, {
          emails: [candidate.email, member.email, 'ghost@example.test'],
        }),
      );
      expect(result.added).toEqual([
        { userId: candidate.id, email: candidate.email, role: 'member' },
      ]);
      expect(result.alreadyMembers).toEqual([member.email]);
      expect(result.unknown).toEqual(['ghost@example.test']);
      expect(await members(group.id)).toContain(`${candidate.id}:member`);

      // The body has no role: asking for one is refused, not ignored.
      const refused = await call(manager, 'POST', `/groups/managed/${group.id}/members`, {
        emails: [outsider.email],
        role: 'manager',
      });
      expect(refused.status).toBe(422);
      expect(await members(group.id)).not.toContain(`${outsider.id}:manager`);

      // Adding a manager by this route leaves them a manager.
      await call(manager, 'POST', `/groups/managed/${group.id}/members`, {
        emails: [anotherManager.email],
      });
      expect(await members(group.id)).toContain(`${anotherManager.id}:manager`);

      const entry = (
        await live.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'group.member.add'))
      ).find((row) => row.actorUserId === manager.id && row.targetId === group.id);
      expect(entry?.metadata).toMatchObject({ viaManager: true, userIds: [candidate.id] });
    });

    it('removes a member at once, and the person is then in no group', async () => {
      expect(
        (await json<{ groups: MyGroup[] }>(await call(candidate, 'GET', '/groups/mine'))).groups,
      ).toHaveLength(1);
      expect(
        (await call(manager, 'DELETE', `/groups/managed/${group.id}/members/${candidate.id}`))
          .status,
      ).toBe(200);
      expect(
        (await json<{ groups: MyGroup[] }>(await call(candidate, 'GET', '/groups/mine'))).groups,
      ).toEqual([]);
      const entry = (
        await live.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'group.member.remove'))
      ).find((row) => row.actorUserId === manager.id);
      expect(entry?.metadata).toMatchObject({ viaManager: true, userIds: [candidate.id] });
      // Not a member: 404, not a silent success.
      expect(
        (await call(manager, 'DELETE', `/groups/managed/${group.id}/members/${candidate.id}`))
          .status,
      ).toBe(404);
    });

    it('cannot remove another manager', async () => {
      const error = await refusal(
        await call(manager, 'DELETE', `/groups/managed/${group.id}/members/${anotherManager.id}`),
        403,
      );
      expect(error.message).toMatch(/administrator/i);
      expect(await members(group.id)).toContain(`${anotherManager.id}:manager`);
    });

    it('may remove themselves, and then manages nothing', async () => {
      const leaving = await person(live.db, organizationId, { name: 'Lee Leaving' });
      await addMember(live.db, group.id, leaving.id, 'manager');
      expect(
        (await call(leaving, 'DELETE', `/groups/managed/${group.id}/members/${leaving.id}`)).status,
      ).toBe(200);
      expect(await members(group.id)).not.toContain(`${leaving.id}:manager`);
      expect((await call(leaving, 'GET', `/groups/managed/${group.id}/members`)).status).toBe(404);
      expect(
        (await json<{ groups: ManagedGroup[] }>(await call(leaving, 'GET', '/groups/managed')))
          .groups,
      ).toEqual([]);
    });

    it('may not remove a member of a group from another group’s page', async () => {
      // The member is in Physics, not History: History's manager gets 403 for Physics,
      // and 404 for the person in History.
      expect(
        (await call(managerOfOther, 'DELETE', `/groups/managed/${other.id}/members/${member.id}`))
          .status,
      ).toBe(404);
      expect(await members(group.id)).toContain(`${member.id}:member`);
    });

    it('is held to the member cap and the per-person cap, changing nothing, with the numbers', async () => {
      const busy = await person(live.db, organizationId, { email: 'busy-managed@example.test' });
      for (let i = 0; i < MAX_GROUPS_PER_PERSON; i++) {
        await addMember(
          live.db,
          (await groupNamed(live.db, organizationId, `Managed busy ${i}`)).id,
          busy.id,
        );
      }
      const error = await refusal(
        await call(manager, 'POST', `/groups/managed/${group.id}/members`, {
          emails: [busy.email],
        }),
        409,
      );
      expect(error.details).toMatchObject({ reason: 'person_group_limit', limit: 50 });

      const full = await groupNamed(live.db, organizationId, 'Managed full');
      const head = await person(live.db, organizationId);
      await addMember(live.db, full.id, head.id, 'manager');
      await live.db.execute(sql`
        with made as (
          insert into "user" (id, name, email, email_verified, role, organization_id)
          select gen_random_uuid()::text, 'M ' || g, 'bulk-mfull-' || g || '@example.test', true, 'user', ${organizationId}
          from generate_series(1, ${MAX_MEMBERS_PER_GROUP - 1}) g
          returning id)
        insert into group_member (group_id, user_id) select ${full.id}, id from made`);
      const refused = await refusal(
        await call(head, 'POST', `/groups/managed/${full.id}/members`, {
          emails: [candidate.email],
        }),
        409,
      );
      expect(refused.details).toMatchObject({
        reason: 'member_limit',
        limit: MAX_MEMBERS_PER_GROUP,
      });
      await live.db.execute(sql`delete from "user" where email like 'bulk-mfull-%'`);
    });

    it('is rate limited when looking people up by email', async () => {
      const busy = await person(live.db, organizationId);
      const target = await groupNamed(live.db, organizationId, 'Rate limited');
      await addMember(live.db, target.id, busy.id, 'manager');
      let last = 200;
      for (let i = 0; i <= PERSON_LOOKUPS_PER_MINUTE; i++) {
        last = (
          await call(busy, 'POST', `/groups/managed/${target.id}/members`, {
            emails: [`nobody-${i}@example.test`],
          })
        ).status;
      }
      expect(last).toBe(429);
    });
  });
});
