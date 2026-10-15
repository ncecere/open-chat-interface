import { eq, schema } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Actor, addMember, call, groupNamed, person } from '../../../test/groups.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  events: [] as unknown[],
  afterDelete: [] as unknown[],
  tx: null as null | { select: (...args: never[]) => unknown },
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));
vi.mock('../../services/groups/access-changes.js', () => ({
  onGroupMembersRemoved: async (tx: unknown, groupId: string, userIds: string[]) => {
    state.events.push({
      event: 'removed',
      groupId,
      userIds,
      // What the hook can already read: the membership is gone.
      remaining: await (
        tx as {
          select: () => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
        }
      )
        .select()
        .from(schema.groupMember)
        .where(eq(schema.groupMember.groupId, groupId)),
    });
  },
  onGroupDeleting: async (tx: unknown, groupId: string, memberIds: string[]) => {
    const rows = await (
      tx as {
        select: () => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
      }
    )
      .select()
      .from(schema.group)
      .where(eq(schema.group.id, groupId));
    state.events.push({ event: 'deleting', groupId, memberIds, groupStillThere: rows.length });
    return async () => {
      const after = await (
        tx as {
          select: () => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
        }
      )
        .select()
        .from(schema.group)
        .where(eq(schema.group.id, groupId));
      const members = await (
        tx as {
          select: () => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
        }
      )
        .select()
        .from(schema.groupMember)
        .where(eq(schema.groupMember.groupId, groupId));
      state.afterDelete.push({ groupGone: after.length === 0, membersGone: members.length === 0 });
    };
  },
  countGroupSharedProjects: async () => 0,
}));

/**
 * The contract project sharing builds on (services/groups/access-changes.ts):
 * when the hooks run, with what, and in which transaction state.
 */
describe.skipIf(!available)('live: the hooks project sharing fills in', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let admin: Actor;
  let manager: Actor;

  beforeAll(async () => {
    live = await createLiveDatabase('groups_hooks');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    admin = await person(live.db, organizationId, { role: 'admin' });
    manager = await person(live.db, organizationId, { role: 'user' });
  });
  beforeEach(() => {
    state.events = [];
    state.afterDelete = [];
  });
  afterAll(async () => {
    await live.destroy();
  });

  it('tells it who was removed, after the membership row is gone, whoever removed them', async () => {
    const group = await groupNamed(live.db, organizationId, 'Hooked');
    const member = await person(live.db, organizationId);
    const other = await person(live.db, organizationId);
    await addMember(live.db, group.id, manager.id, 'manager');
    await addMember(live.db, group.id, member.id);
    await addMember(live.db, group.id, other.id);

    await call(admin, 'DELETE', `/admin/groups/${group.id}/members/${member.id}`);
    await call(manager, 'DELETE', `/groups/managed/${group.id}/members/${other.id}`);
    expect(state.events).toEqual([
      { event: 'removed', groupId: group.id, userIds: [member.id], remaining: expect.any(Array) },
      { event: 'removed', groupId: group.id, userIds: [other.id], remaining: expect.any(Array) },
    ]);
    const [first] = state.events as { remaining: { userId: string }[] }[];
    expect(first?.remaining.map((row) => row.userId)).not.toContain(member.id);
    // Not for a change that removed nobody.
    state.events = [];
    await call(admin, 'DELETE', `/admin/groups/${group.id}/members/${member.id}`);
    expect(state.events).toEqual([]);
  });

  it('announces a deletion before it, with the members, and runs the follow-up after it, in the same transaction', async () => {
    const group = await groupNamed(live.db, organizationId, 'Doomed');
    const a = await person(live.db, organizationId);
    const b = await person(live.db, organizationId);
    await addMember(live.db, group.id, b.id);
    await addMember(live.db, group.id, a.id);
    await call(admin, 'DELETE', `/admin/groups/${group.id}`);
    expect(state.events).toEqual([
      {
        event: 'deleting',
        groupId: group.id,
        memberIds: [a.id, b.id].sort(),
        groupStillThere: 1,
      },
    ]);
    expect(state.afterDelete).toEqual([{ groupGone: true, membersGone: true }]);
    expect(
      await live.db.select().from(schema.group).where(eq(schema.group.id, group.id)),
    ).toHaveLength(0);
  });
});
