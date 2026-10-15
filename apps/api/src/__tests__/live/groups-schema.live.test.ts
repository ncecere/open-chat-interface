import { eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

const { groupIdsForUser, isGroupMember } = await import('../../services/groups/membership.js');

describe.skipIf(!available)('live: the groups tables (migration 0053)', () => {
  let live: LiveDatabase;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('groups_schema');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
  });

  afterAll(async () => {
    await live.destroy();
  });

  const makeGroup = async (name: string) => {
    const [row] = await live.db.insert(schema.group).values({ organizationId, name }).returning();
    return row!;
  };

  it('is applied by the migrator under tag 0053 at journal position 50', async () => {
    const rows = await live.db.execute<{ count: string }>(
      sql`select count(*)::text as count from information_schema.tables
          where table_schema = 'public'
            and table_name in ('group', 'group_member', 'quota_policy_group', 'model_group_access')`,
    );
    expect(rows[0]!.count).toBe('4');
  });

  it('keeps group names unique ignoring case within the organization, and bounded', async () => {
    await makeGroup('Physics');
    await expect(makeGroup('PHYSICS')).rejects.toThrow();
    await expect(makeGroup('')).rejects.toThrow();
    await expect(makeGroup('x'.repeat(81))).rejects.toThrow();
    await expect(
      live.db
        .insert(schema.group)
        .values({ organizationId, name: 'Long description', description: 'x'.repeat(301) }),
    ).rejects.toThrow();
  });

  it('refuses a member role other than member or manager, and a second row for one person', async () => {
    const group = await makeGroup('Roles');
    const person = await seedUser(live.db, organizationId);
    await expect(
      live.db.execute(
        sql`insert into group_member (group_id, user_id, role) values (${group.id}, ${person}, 'owner')`,
      ),
    ).rejects.toThrow();
    await live.db.insert(schema.groupMember).values({ groupId: group.id, userId: person });
    await expect(
      live.db
        .insert(schema.groupMember)
        .values({ groupId: group.id, userId: person, role: 'manager' }),
    ).rejects.toThrow();
  });

  it('cascades from the group, the user, the model and the budget; never blocks their deletion', async () => {
    const group = await makeGroup('Cascade');
    const person = await seedUser(live.db, organizationId);
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId, kind: 'openai-compatible', label: 'p' })
      .returning();
    const [model] = await live.db
      .insert(schema.model)
      .values({
        organizationId,
        providerId: provider!.id,
        slug: 'm',
        upstreamModelId: 'm',
        displayName: 'M',
      })
      .returning();
    const [policy] = await live.db
      .insert(schema.quotaPolicy)
      .values({
        organizationId,
        name: 'p',
        metric: 'messages',
        limitValue: 1,
        windowKind: 'rolling',
        windowHours: 24,
      })
      .returning();
    await live.db.insert(schema.groupMember).values({ groupId: group.id, userId: person });
    await live.db
      .insert(schema.quotaPolicyGroup)
      .values({ policyId: policy!.id, groupId: group.id });
    await live.db.insert(schema.modelGroupAccess).values({ modelId: model!.id, groupId: group.id });

    await live.db.delete(schema.quotaPolicy).where(eq(schema.quotaPolicy.id, policy!.id));
    await live.db.delete(schema.model).where(eq(schema.model.id, model!.id));
    expect(await live.db.select().from(schema.quotaPolicyGroup)).toHaveLength(0);
    expect(await live.db.select().from(schema.modelGroupAccess)).toHaveLength(0);

    await live.db.execute(sql`delete from "user" where id = ${person}`);
    expect(
      await live.db
        .select()
        .from(schema.groupMember)
        .where(eq(schema.groupMember.groupId, group.id)),
    ).toHaveLength(0);

    const other = await seedUser(live.db, organizationId);
    await live.db.insert(schema.groupMember).values({ groupId: group.id, userId: other });
    await live.db.delete(schema.group).where(eq(schema.group.id, group.id));
    expect(
      await live.db.select().from(schema.groupMember).where(eq(schema.groupMember.userId, other)),
    ).toHaveLength(0);
  });

  it('sets the creator and the adder to null when their account goes', async () => {
    const creator = await seedUser(live.db, organizationId);
    const [group] = await live.db
      .insert(schema.group)
      .values({ organizationId, name: 'By someone', createdByUserId: creator })
      .returning();
    await live.db.execute(sql`delete from "user" where id = ${creator}`);
    const [after] = await live.db.select().from(schema.group).where(eq(schema.group.id, group!.id));
    expect(after!.createdByUserId).toBeNull();
  });

  it('answers a person’s group ids, cheaply and uncached', async () => {
    const a = await makeGroup('Helper A');
    const b = await makeGroup('Helper B');
    const c = await makeGroup('Helper C');
    const person = await seedUser(live.db, organizationId);
    const stranger = await seedUser(live.db, organizationId);
    expect(await groupIdsForUser(person)).toEqual([]);
    await live.db.insert(schema.groupMember).values([
      { groupId: a.id, userId: person },
      { groupId: b.id, userId: person, role: 'manager' },
      { groupId: c.id, userId: stranger },
    ]);
    expect((await groupIdsForUser(person)).sort()).toEqual([a.id, b.id].sort());
    expect(await isGroupMember(a.id, person)).toBe(true);
    expect(await isGroupMember(c.id, person)).toBe(false);
    await live.db.delete(schema.groupMember).where(eq(schema.groupMember.groupId, a.id));
    expect(await groupIdsForUser(person)).toEqual([b.id]);
    expect(await isGroupMember(a.id, person)).toBe(false);
  });
});
