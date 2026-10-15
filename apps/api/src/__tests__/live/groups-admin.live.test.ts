import { createDatabase, eq, schema, sql } from '@oci/db';
import {
  type AddGroupMembersResult,
  type AdminGroup,
  type AdminGroupDetail,
  type AdminGroupsPage,
  type DeleteGroupResult,
  type GroupMember,
  type GroupMembersPage,
  MAX_GROUPS,
  MAX_GROUPS_PER_PERSON,
  MAX_MANAGERS_PER_GROUP,
  MAX_MEMBERS_PER_GROUP,
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

describe.skipIf(!available)('live: administering groups', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let admin: Actor;
  let auditor: Actor;
  let ordinary: Actor;

  const auditActions = async () =>
    (await live.db.select().from(schema.auditLog).orderBy(schema.auditLog.seq)).map((row) => ({
      action: row.action,
      targetId: row.targetId,
      actor: row.actorUserId,
      metadata: row.metadata as Record<string, unknown> | null,
    }));

  /** Runs the requests at once, each on its own connection (the live database has one). */
  async function atOnce<T>(requests: () => Promise<T>[]): Promise<T[]> {
    const { db: pooled, sql: client } = createDatabase(live.connectionString, { max: 4 });
    state.db = pooled;
    try {
      return await Promise.all(requests());
    } finally {
      state.db = live.db;
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    live = await createLiveDatabase('groups_admin');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    admin = await person(live.db, organizationId, { role: 'admin', name: 'Ada Admin' });
    auditor = await person(live.db, organizationId, { role: 'auditor', name: 'Aud Itor' });
    ordinary = await person(live.db, organizationId, { role: 'user', name: 'Olive Ordinary' });
  });

  afterAll(async () => {
    await live.destroy();
  });

  describe('who may', () => {
    it('refuses everyone but administrators and auditors, and lets auditors only read', async () => {
      const group = await groupNamed(live.db, organizationId, 'Permissions');
      expect((await call(null, 'GET', '/admin/groups')).status).toBe(401);
      expect((await call(ordinary, 'GET', '/admin/groups')).status).toBe(403);
      expect((await call(ordinary, 'POST', '/admin/groups', { name: 'x' })).status).toBe(403);

      expect((await call(auditor, 'GET', '/admin/groups')).status).toBe(200);
      expect((await call(auditor, 'GET', `/admin/groups/${group.id}`)).status).toBe(200);
      expect((await call(auditor, 'GET', `/admin/groups/${group.id}/members`)).status).toBe(200);
      expect((await call(auditor, 'GET', `/admin/groups/${group.id}/grants`)).status).toBe(200);
      for (const [method, path, body] of [
        ['POST', '/admin/groups', { name: 'Nope' }],
        ['PATCH', `/admin/groups/${group.id}`, { name: 'Nope' }],
        ['DELETE', `/admin/groups/${group.id}`, undefined],
        ['POST', `/admin/groups/${group.id}/members`, { emails: [ordinary.email] }],
        ['PATCH', `/admin/groups/${group.id}/members/${ordinary.id}`, { role: 'manager' }],
        ['DELETE', `/admin/groups/${group.id}/members/${ordinary.id}`, undefined],
        ['PUT', `/admin/groups/${group.id}/grants`, { policyIds: [], modelIds: [] }],
      ] as const) {
        expect((await call(auditor, method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      expect(await live.db.select().from(schema.groupMember)).toHaveLength(0);
    });

    it('answers 404 for a group that does not exist', async () => {
      for (const [method, path, body] of [
        ['GET', '/admin/groups/nope', undefined],
        ['PATCH', '/admin/groups/nope', { name: 'x' }],
        ['DELETE', '/admin/groups/nope', undefined],
        ['GET', '/admin/groups/nope/members', undefined],
        ['POST', '/admin/groups/nope/members', { emails: ['a@example.test'] }],
        ['GET', '/admin/groups/nope/grants', undefined],
        ['PUT', '/admin/groups/nope/grants', { policyIds: [], modelIds: [] }],
      ] as const) {
        expect((await call(admin, method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    });
  });

  describe('create, list, rename, delete', () => {
    it('creates a group, trims the name, lists it with counts and audits it', async () => {
      const created = await json<AdminGroup>(
        await call(admin, 'POST', '/admin/groups', {
          name: '  Chemistry  ',
          description: 'The department',
        }),
        201,
      );
      expect(created).toMatchObject({
        name: 'Chemistry',
        description: 'The department',
        memberCount: 0,
        managerCount: 0,
        policyCount: 0,
        modelCount: 0,
      });
      const page = await json<AdminGroupsPage>(
        await call(admin, 'GET', '/admin/groups?search=chem'),
      );
      expect(page).toMatchObject({ page: 1, total: 1, limit: MAX_GROUPS });
      expect(page.groups.map((g) => g.id)).toEqual([created.id]);

      const entry = (await auditActions()).find(
        (row) => row.action === 'group.create' && row.targetId === created.id,
      );
      expect(entry).toMatchObject({ actor: admin.id, metadata: { name: 'Chemistry' } });
    });

    it('refuses a duplicate name ignoring case, an empty name and an unknown field', async () => {
      await json<AdminGroup>(await call(admin, 'POST', '/admin/groups', { name: 'Biology' }), 201);
      const taken = await refusal(
        await call(admin, 'POST', '/admin/groups', { name: 'BIOLOGY' }),
        409,
      );
      expect(taken.details).toMatchObject({ reason: 'name_taken' });
      expect((await call(admin, 'POST', '/admin/groups', { name: '  ' })).status).toBe(422);
      expect((await call(admin, 'POST', '/admin/groups', { name: 'x', members: [] })).status).toBe(
        422,
      );
    });

    it('pages and searches', async () => {
      for (let i = 0; i < 5; i++) await groupNamed(live.db, organizationId, `Paging ${i}`);
      const first = await json<AdminGroupsPage>(
        await call(admin, 'GET', '/admin/groups?search=paging&pageSize=2&page=1'),
      );
      const last = await json<AdminGroupsPage>(
        await call(admin, 'GET', '/admin/groups?search=paging&pageSize=2&page=3'),
      );
      expect(first.total).toBe(5);
      expect(first.groups).toHaveLength(2);
      expect(last.groups).toHaveLength(1);
      expect((await call(admin, 'GET', '/admin/groups?pageSize=101')).status).toBe(422);
    });

    it('renames, clears the description, refuses a taken name and an empty change, audits the change', async () => {
      const group = await json<AdminGroup>(
        await call(admin, 'POST', '/admin/groups', { name: 'Rename me', description: 'old' }),
        201,
      );
      await groupNamed(live.db, organizationId, 'Already used');
      const renamed = await json<AdminGroup>(
        await call(admin, 'PATCH', `/admin/groups/${group.id}`, {
          name: 'Renamed',
          description: null,
        }),
      );
      expect(renamed).toMatchObject({ name: 'Renamed', description: null });
      const taken = await refusal(
        await call(admin, 'PATCH', `/admin/groups/${group.id}`, { name: 'already USED' }),
        409,
      );
      expect(taken.details).toMatchObject({ reason: 'name_taken' });
      expect((await call(admin, 'PATCH', `/admin/groups/${group.id}`, {})).status).toBe(422);
      // The same name in another case is a rename of itself, not a clash.
      expect(
        (await call(admin, 'PATCH', `/admin/groups/${group.id}`, { name: 'RENAMED' })).status,
      ).toBe(200);

      const update = (await auditActions()).find(
        (row) => row.action === 'group.update' && row.targetId === group.id,
      );
      expect(update?.metadata).toMatchObject({
        changes: expect.arrayContaining([
          expect.objectContaining({ key: 'name', before: 'Rename me', after: 'Renamed' }),
        ]),
      });
    });

    it('deletes a group with its members and grants, says how many went, and audits it', async () => {
      const group = await groupNamed(live.db, organizationId, 'To delete');
      const a = await person(live.db, organizationId);
      const b = await person(live.db, organizationId);
      await addMember(live.db, group.id, a.id);
      await addMember(live.db, group.id, b.id, 'manager');
      const detail = await json<AdminGroupDetail>(
        await call(admin, 'GET', `/admin/groups/${group.id}`),
      );
      expect(detail).toMatchObject({ memberCount: 2, managerCount: 1, sharedProjectCount: 0 });

      const result = await json<DeleteGroupResult>(
        await call(admin, 'DELETE', `/admin/groups/${group.id}`),
      );
      expect(result).toEqual({
        ok: true,
        removed: { members: 2, policies: 0, models: 0, sharedProjects: 0 },
      });
      expect(
        await live.db
          .select()
          .from(schema.groupMember)
          .where(eq(schema.groupMember.groupId, group.id)),
      ).toHaveLength(0);
      // The people stay.
      expect(await live.db.select().from(schema.user).where(eq(schema.user.id, a.id))).toHaveLength(
        1,
      );
      const entry = (await auditActions()).find(
        (row) => row.action === 'group.delete' && row.targetId === group.id,
      );
      expect(entry?.metadata).toMatchObject({
        name: 'To delete',
        removed: { members: 2, policies: 0, models: 0, sharedProjects: 0 },
      });
      expect((await call(admin, 'GET', `/admin/groups/${group.id}`)).status).toBe(404);
    });

    it('refuses a new group at the cap and says the number', async () => {
      await live.db.execute(
        sql`insert into "group" (organization_id, name)
            select ${organizationId}, 'bulk ' || g from generate_series(1, ${MAX_GROUPS}) g
            on conflict do nothing`,
      );
      const total = (await live.db.select().from(schema.group)).length;
      expect(total).toBeGreaterThanOrEqual(MAX_GROUPS);
      const error = await refusal(
        await call(admin, 'POST', '/admin/groups', { name: 'One more' }),
        409,
      );
      expect(error.message).toContain('500');
      expect(error.details).toMatchObject({ reason: 'group_limit', limit: MAX_GROUPS });
      await live.db.execute(sql`delete from "group" where name like 'bulk %'`);
    });
  });

  describe('at the same moment', () => {
    it('lets one of two creates with the same name win, and one of two at the cap', async () => {
      const same = await atOnce(() =>
        [1, 2].map(() => call(admin, 'POST', '/admin/groups', { name: 'Same name' })),
      );
      expect(same.map((r) => r.status).sort()).toEqual([201, 409]);

      const [{ value }] = await live.db
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.group);
      await live.db.execute(
        sql`insert into "group" (organization_id, name)
            select ${organizationId}, 'cap ' || g from generate_series(1, ${MAX_GROUPS - 1 - value!}) g`,
      );
      const last = await atOnce(() =>
        ['Last A', 'Last B'].map((name) => call(admin, 'POST', '/admin/groups', { name })),
      );
      expect(last.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await live.db.select().from(schema.group)).toHaveLength(MAX_GROUPS);
      await live.db.execute(sql`delete from "group" where name like 'cap %' or name like 'Last %'`);
    });
  });

  describe('membership', () => {
    it('adds by email ignoring case, sorts every address into one list, and audits one entry', async () => {
      const group = await groupNamed(live.db, organizationId, 'Adding');
      const ann = await person(live.db, organizationId, {
        name: 'Ann',
        email: 'Ann.Add@Example.test',
      });
      const bob = await person(live.db, organizationId, { name: 'Bob' });
      await addMember(live.db, group.id, bob.id);
      const result = await json<AddGroupMembersResult>(
        await call(admin, 'POST', `/admin/groups/${group.id}/members`, {
          emails: [
            'ANN.ADD@example.test',
            bob.email,
            'nobody@example.test',
            'ann.add@example.test',
          ],
        }),
      );
      expect(result.added).toEqual([{ userId: ann.id, email: ann.email, role: 'member' }]);
      expect(result.alreadyMembers).toEqual([bob.email]);
      expect(result.unknown).toEqual(['nobody@example.test']);
      expect(result.memberCount).toBe(2);

      const entries = (await auditActions()).filter(
        (row) => row.action === 'group.member.add' && row.targetId === group.id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.metadata).toMatchObject({
        userIds: [ann.id],
        viaManager: false,
        role: 'member',
      });
    });

    it('records nothing when nobody was added', async () => {
      const group = await groupNamed(live.db, organizationId, 'Adding nobody');
      const before = (await auditActions()).length;
      const result = await json<AddGroupMembersResult>(
        await call(admin, 'POST', `/admin/groups/${group.id}/members`, {
          emails: ['ghost@example.test'],
        }),
      );
      expect(result.added).toEqual([]);
      expect((await auditActions()).length).toBe(before);
    });

    it('lists with search and paging, naming the role', async () => {
      const group = await groupNamed(live.db, organizationId, 'Listing');
      const names = ['Zed Zulu', 'Amy Alpha', 'Bea Bravo'];
      for (const [i, name] of names.entries()) {
        const p = await person(live.db, organizationId, { name, email: `list${i}@example.test` });
        await addMember(live.db, group.id, p.id, name.startsWith('Amy') ? 'manager' : 'member');
      }
      const page = await json<GroupMembersPage>(
        await call(admin, 'GET', `/admin/groups/${group.id}/members?pageSize=2`),
      );
      expect(page.total).toBe(3);
      expect(page.members.map((m) => m.name)).toEqual(['Amy Alpha', 'Bea Bravo']);
      expect(page.members[0]?.role).toBe('manager');
      const byEmail = await json<GroupMembersPage>(
        await call(admin, 'GET', `/admin/groups/${group.id}/members?search=LIST0`),
      );
      expect(byEmail.members.map((m) => m.name)).toEqual(['Zed Zulu']);
      const byName = await json<GroupMembersPage>(
        await call(admin, 'GET', `/admin/groups/${group.id}/members?search=bravo`),
      );
      expect(byName.members.map((m) => m.name)).toEqual(['Bea Bravo']);
    });

    it('appoints and removes managers, never past the cap, and audits the role change', async () => {
      const group = await groupNamed(live.db, organizationId, 'Managers');
      const p = await person(live.db, organizationId);
      await addMember(live.db, group.id, p.id);
      const promoted = await json<GroupMember>(
        await call(admin, 'PATCH', `/admin/groups/${group.id}/members/${p.id}`, {
          role: 'manager',
        }),
      );
      expect(promoted.role).toBe('manager');
      const demoted = await json<GroupMember>(
        await call(admin, 'PATCH', `/admin/groups/${group.id}/members/${p.id}`, {
          role: 'member',
        }),
      );
      expect(demoted.role).toBe('member');
      const roleEntries = (await auditActions()).filter(
        (row) => row.action === 'group.member.role' && row.targetId === group.id,
      );
      expect(roleEntries.map((e) => e.metadata)).toEqual([
        expect.objectContaining({ userId: p.id, before: 'member', after: 'manager' }),
        expect.objectContaining({ userId: p.id, before: 'manager', after: 'member' }),
      ]);

      const outsider = await person(live.db, organizationId);
      expect(
        (
          await call(admin, 'PATCH', `/admin/groups/${group.id}/members/${outsider.id}`, {
            role: 'manager',
          })
        ).status,
      ).toBe(404);

      // The cap on managers.
      for (let i = 0; i < MAX_MANAGERS_PER_GROUP; i++) {
        const m = await person(live.db, organizationId);
        await addMember(live.db, group.id, m.id, 'manager');
      }
      const full = await refusal(
        await call(admin, 'PATCH', `/admin/groups/${group.id}/members/${p.id}`, {
          role: 'manager',
        }),
        409,
      );
      expect(full.message).toContain('20');
      expect(full.details).toMatchObject({
        reason: 'manager_limit',
        limit: MAX_MANAGERS_PER_GROUP,
      });
      const extra = await person(live.db, organizationId);
      const addAsManager = await refusal(
        await call(admin, 'POST', `/admin/groups/${group.id}/members`, {
          emails: [extra.email],
          role: 'manager',
        }),
        409,
      );
      expect(addAsManager.details).toMatchObject({ reason: 'manager_limit' });
      // As a plain member it still fits.
      expect(
        (
          await call(admin, 'POST', `/admin/groups/${group.id}/members`, {
            emails: [extra.email],
          })
        ).status,
      ).toBe(200);
    });

    it('removes a member, 404 for a stranger, and audits it', async () => {
      const group = await groupNamed(live.db, organizationId, 'Removing');
      const p = await person(live.db, organizationId);
      await addMember(live.db, group.id, p.id);
      expect(
        (
          await json<{ ok: boolean }>(
            await call(admin, 'DELETE', `/admin/groups/${group.id}/members/${p.id}`),
          )
        ).ok,
      ).toBe(true);
      expect(
        (await call(admin, 'DELETE', `/admin/groups/${group.id}/members/${p.id}`)).status,
      ).toBe(404);
      const entry = (await auditActions()).find(
        (row) => row.action === 'group.member.remove' && row.targetId === group.id,
      );
      expect(entry?.metadata).toMatchObject({ userIds: [p.id], viaManager: false });
    });

    it('refuses an add that would pass the member cap, changing nothing, and says the number', async () => {
      const group = await groupNamed(live.db, organizationId, 'Big');
      await live.db.execute(sql`
        with made as (
          insert into "user" (id, name, email, email_verified, role, organization_id)
          select gen_random_uuid()::text, 'Bulk ' || g, 'bulk-big-' || g || '@example.test', true, 'user', ${organizationId}
          from generate_series(1, ${MAX_MEMBERS_PER_GROUP}) g
          returning id)
        insert into group_member (group_id, user_id) select ${group.id}, id from made`);
      const extra = await person(live.db, organizationId);
      const error = await refusal(
        await call(admin, 'POST', `/admin/groups/${group.id}/members`, { emails: [extra.email] }),
        409,
      );
      expect(error.message).toContain('5,000');
      expect(error.details).toMatchObject({ reason: 'member_limit', limit: MAX_MEMBERS_PER_GROUP });
      expect(
        await live.db
          .select()
          .from(schema.groupMember)
          .where(eq(schema.groupMember.userId, extra.id)),
      ).toHaveLength(0);
      await live.db.execute(sql`delete from "user" where email like 'bulk-big-%'`);
    });

    it('refuses a person already in the most groups allowed, naming them, and changes nothing', async () => {
      const busy = await person(live.db, organizationId, { email: 'busy@example.test' });
      const fine = await person(live.db, organizationId, { email: 'fine@example.test' });
      for (let i = 0; i < MAX_GROUPS_PER_PERSON; i++) {
        await addMember(
          live.db,
          (await groupNamed(live.db, organizationId, `Busy ${i}`)).id,
          busy.id,
        );
      }
      const target = await groupNamed(live.db, organizationId, 'One too many');
      const error = await refusal(
        await call(admin, 'POST', `/admin/groups/${target.id}/members`, {
          emails: [busy.email, fine.email],
        }),
        409,
      );
      expect(error.message).toContain('50');
      expect(error.details).toMatchObject({
        reason: 'person_group_limit',
        limit: MAX_GROUPS_PER_PERSON,
        emails: ['busy@example.test'],
      });
      expect(
        await live.db
          .select()
          .from(schema.groupMember)
          .where(eq(schema.groupMember.groupId, target.id)),
      ).toHaveLength(0);
    });

    it('holds the per-person cap when two groups add the same person at once', async () => {
      const racer = await person(live.db, organizationId, { email: 'racer@example.test' });
      for (let i = 0; i < MAX_GROUPS_PER_PERSON - 1; i++) {
        await addMember(
          live.db,
          (await groupNamed(live.db, organizationId, `Race ${i}`)).id,
          racer.id,
        );
      }
      const a = await groupNamed(live.db, organizationId, 'Race A');
      const b = await groupNamed(live.db, organizationId, 'Race B');
      const results = await atOnce(() =>
        [a, b].map((g) =>
          call(admin, 'POST', `/admin/groups/${g.id}/members`, { emails: [racer.email] }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await live.db
          .select()
          .from(schema.groupMember)
          .where(eq(schema.groupMember.userId, racer.id)),
      ).toHaveLength(MAX_GROUPS_PER_PERSON);
    });

    it('holds the member cap when two requests race for the last place', async () => {
      const group = await groupNamed(live.db, organizationId, 'Last place');
      await live.db.execute(sql`
        with made as (
          insert into "user" (id, name, email, email_verified, role, organization_id)
          select gen_random_uuid()::text, 'Fill ' || g, 'bulk-fill-' || g || '@example.test', true, 'user', ${organizationId}
          from generate_series(1, ${MAX_MEMBERS_PER_GROUP - 1}) g
          returning id)
        insert into group_member (group_id, user_id) select ${group.id}, id from made`);
      const x = await person(live.db, organizationId);
      const y = await person(live.db, organizationId);
      const results = await atOnce(() =>
        [x, y].map((p) =>
          call(admin, 'POST', `/admin/groups/${group.id}/members`, { emails: [p.email] }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const rows = await live.db.execute<{ count: string }>(
        sql`select count(*)::text as count from group_member where group_id = ${group.id}`,
      );
      expect(rows[0]?.count).toBe(String(MAX_MEMBERS_PER_GROUP));
      await live.db.execute(sql`delete from "user" where email like 'bulk-fill-%'`);
    });

    it('lists a person’s groups for the user detail', async () => {
      const p = await person(live.db, organizationId);
      const g1 = await groupNamed(live.db, organizationId, 'Zeta detail');
      const g2 = await groupNamed(live.db, organizationId, 'Alpha detail');
      await addMember(live.db, g1.id, p.id);
      await addMember(live.db, g2.id, p.id, 'manager');
      const body = await json<{ groups: { id: string; name: string; role: string }[] }>(
        await call(admin, 'GET', `/admin/users/${p.id}/groups`),
      );
      expect(body.groups).toEqual([
        { id: g2.id, name: 'Alpha detail', role: 'manager' },
        { id: g1.id, name: 'Zeta detail', role: 'member' },
      ]);
    });
  });
});
