import { schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * `projectAccess` (TypeScript) and `projectReadableBy` / `projectEditableBy`
 * (raw SQL) are one rule in two forms. This runs both, and an independent
 * oracle written from the rule in the spec, over every person x project pair of
 * generated data: owners, direct and group shares of both permissions, a person
 * who is named twice (the highest wins), a group the person left, a deleted
 * group, and a project that does not exist.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

const { meetsAccess, projectAccess, projectEditableBy, projectReadableBy, requireProjectAccess } =
  await import('../../services/project-sharing/access.js');

type Level = 'owner' | 'editor' | 'viewer';

describe.skipIf(!available)('live: project access, TypeScript and SQL', () => {
  let live: LiveDatabase;
  let organizationId: string;
  const users: string[] = [];
  const projects: string[] = [];
  const groups: string[] = [];
  /** The oracle's own bookkeeping, filled by the seed below. */
  const owners = new Map<string, string>();
  const shares: Array<{ project: string; user?: string; group?: string; permission: Level }> = [];
  const members = new Map<string, Set<string>>();

  beforeAll(async () => {
    live = await createLiveDatabase('project_access');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    for (let i = 0; i < 7; i += 1) users.push(await seedUser(live.db, organizationId));
    for (let i = 0; i < 3; i += 1) {
      const [row] = await live.db
        .insert(schema.group)
        .values({ organizationId, name: `Group ${i}` })
        .returning();
      groups.push(row!.id);
      members.set(row!.id, new Set());
    }
    const join = async (group: number, user: number) => {
      await live.db
        .insert(schema.groupMember)
        .values({ groupId: groups[group]!, userId: users[user]! });
      members.get(groups[group]!)!.add(users[user]!);
    };
    // users[3] and users[4] are in group 0; users[4] and users[5] in group 1; group 2 is empty.
    await join(0, 3);
    await join(0, 4);
    await join(1, 4);
    await join(1, 5);
    for (let i = 0; i < 6; i += 1) {
      const [row] = await live.db
        .insert(schema.project)
        .values({ organizationId, userId: users[i % 3]!, name: `Project ${i}` })
        .returning();
      projects.push(row!.id);
      owners.set(row!.id, users[i % 3]!);
    }
    const share = async (
      project: number,
      subject: { user?: number; group?: number },
      permission: 'viewer' | 'editor',
    ) => {
      await live.db.insert(schema.projectShare).values({
        projectId: projects[project]!,
        subjectType: subject.user !== undefined ? 'person' : 'group',
        subjectUserId: subject.user !== undefined ? users[subject.user]! : null,
        subjectGroupId: subject.group !== undefined ? groups[subject.group]! : null,
        permission,
      });
      shares.push({
        project: projects[project]!,
        user: subject.user !== undefined ? users[subject.user] : undefined,
        group: subject.group !== undefined ? groups[subject.group] : undefined,
        permission,
      });
    };
    await share(0, { user: 1 }, 'viewer');
    await share(0, { user: 2 }, 'editor');
    await share(1, { group: 0 }, 'viewer');
    await share(2, { group: 0 }, 'editor');
    // users[4] is named by two groups and directly: the highest permission wins.
    await share(3, { group: 0 }, 'viewer');
    await share(3, { group: 1 }, 'editor');
    await share(3, { user: 4 }, 'viewer');
    await share(4, { group: 2 }, 'editor');
    await share(5, { user: 6 }, 'viewer');
  });
  afterAll(async () => {
    await live?.destroy();
  });

  function oracle(project: string, user: string): Level | null {
    if (owners.get(project) === user) return 'owner';
    const granted = shares
      .filter((s) => s.project === project)
      .filter((s) => s.user === user || (s.group && members.get(s.group)?.has(user)))
      .map((s) => s.permission);
    if (granted.includes('editor')) return 'editor';
    return granted.length ? 'viewer' : null;
  }

  async function sqlReadable(project: string, user: string) {
    const [row] = await live.db.execute<{ ok: boolean }>(
      sql`select ${projectReadableBy(project, user)} as ok`,
    );
    return row!.ok;
  }
  async function sqlEditable(project: string, user: string) {
    const [row] = await live.db.execute<{ ok: boolean }>(
      sql`select ${projectEditableBy(project, user)} as ok`,
    );
    return row!.ok;
  }

  it('agrees with the rule, and the SQL twin agrees with the TypeScript, for every pair', async () => {
    let pairs = 0;
    for (const project of projects) {
      for (const user of users) {
        const expected = oracle(project, user);
        expect(await projectAccess(live.db, project, user), `${project} ${user}`).toBe(expected);
        expect(await sqlReadable(project, user), `${project} ${user}`).toBe(expected !== null);
        expect(await sqlEditable(project, user), `${project} ${user}`).toBe(
          expected === 'owner' || expected === 'editor',
        );
        pairs += 1;
      }
    }
    expect(pairs).toBe(42);
    // The generated data really exercises every answer.
    const seen = new Set(projects.flatMap((project) => users.map((user) => oracle(project, user))));
    expect(seen).toEqual(new Set(['owner', 'editor', 'viewer', null]));
  });

  it('takes the highest permission when a person is named more than once', async () => {
    expect(await projectAccess(live.db, projects[3]!, users[4]!)).toBe('editor');
    expect(await projectAccess(live.db, projects[3]!, users[3]!)).toBe('viewer');
  });

  it('answers null for no project, no person and an empty id', async () => {
    expect(await projectAccess(live.db, 'missing', users[0]!)).toBeNull();
    expect(await projectAccess(live.db, projects[0]!, 'missing')).toBeNull();
    expect(await projectAccess(live.db, '', users[0]!)).toBeNull();
    expect(await projectAccess(live.db, projects[0]!, '')).toBeNull();
    expect(await sqlReadable('missing', users[0]!)).toBe(false);
    expect(await sqlReadable(projects[0]!, 'missing')).toBe(false);
  });

  it('works as a column predicate over many projects', async () => {
    for (const user of users) {
      const rows = await live.db.execute<{ id: string }>(
        sql`select pr.id from "project" pr where ${projectReadableBy(sql`pr.id`, user)}`,
      );
      expect(rows.map((row) => row.id).sort()).toEqual(
        projects.filter((project) => oracle(project, user) !== null).sort(),
      );
    }
  });

  it('is computed per request: a removed member, a removed share and a deleted group lose access at once', async () => {
    // users[5] reaches project 5? No: only via group 1 -> project 3 (editor).
    expect(await projectAccess(live.db, projects[3]!, users[5]!)).toBe('editor');
    await live.db.execute(
      sql`delete from group_member where group_id = ${groups[1]!} and user_id = ${users[5]!}`,
    );
    expect(await projectAccess(live.db, projects[3]!, users[5]!)).toBeNull();
    expect(await sqlReadable(projects[3]!, users[5]!)).toBe(false);
    // Put back, then delete the share, then the group (cascades the share).
    await live.db.insert(schema.groupMember).values({ groupId: groups[1]!, userId: users[5]! });
    expect(await projectAccess(live.db, projects[3]!, users[5]!)).toBe('editor');
    await live.db.execute(
      sql`delete from project_share where project_id = ${projects[3]!} and subject_group_id = ${groups[1]!}`,
    );
    expect(await projectAccess(live.db, projects[3]!, users[5]!)).toBeNull();
    await live.db.execute(sql`delete from "group" where id = ${groups[0]!}`);
    expect(await projectAccess(live.db, projects[1]!, users[3]!)).toBeNull();
    expect(await projectAccess(live.db, projects[2]!, users[3]!)).toBeNull();
  });

  describe('requireProjectAccess', () => {
    it('answers 404 for none, 403 for too little, and the level otherwise', async () => {
      // projects[0]: users[1] is a viewer, users[2] an editor, users[0] the owner.
      expect(await requireProjectAccess(projects[0]!, users[1]!, 'viewer', live.db)).toBe('viewer');
      expect(await requireProjectAccess(projects[0]!, users[2]!, 'editor', live.db)).toBe('editor');
      expect(await requireProjectAccess(projects[0]!, users[0]!, 'owner', live.db)).toBe('owner');
      await expect(
        requireProjectAccess(projects[0]!, users[1]!, 'editor', live.db),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        requireProjectAccess(projects[0]!, users[2]!, 'owner', live.db),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        requireProjectAccess(projects[0]!, users[6]!, 'viewer', live.db),
      ).rejects.toMatchObject({ status: 404, message: 'Project not found' });
      await expect(
        requireProjectAccess('missing', users[0]!, 'viewer', live.db),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('ranks the levels', () => {
      expect(meetsAccess('owner', 'editor')).toBe(true);
      expect(meetsAccess('editor', 'editor')).toBe(true);
      expect(meetsAccess('viewer', 'editor')).toBe(false);
      expect(meetsAccess('viewer', 'viewer')).toBe(true);
      expect(meetsAccess(null, 'viewer')).toBe(false);
    });
  });

  describe('the table', () => {
    it('allows exactly one subject, a known type and a known permission', async () => {
      const base = { projectId: projects[5]!, permission: 'viewer' as const };
      await expect(
        live.db.insert(schema.projectShare).values({
          ...base,
          subjectType: 'person',
          subjectUserId: users[0]!,
          subjectGroupId: groups[2]!,
        }),
      ).rejects.toThrow();
      await expect(
        live.db.insert(schema.projectShare).values({ ...base, subjectType: 'person' }),
      ).rejects.toThrow();
      await expect(
        live.db.insert(schema.projectShare).values({
          ...base,
          subjectType: 'group',
          subjectUserId: users[0]!,
          subjectGroupId: null,
        }),
      ).rejects.toThrow();
      await expect(
        live.db.insert(schema.projectShare).values({
          ...base,
          subjectType: 'person',
          subjectUserId: users[0]!,
          permission: 'owner' as never,
        }),
      ).rejects.toThrow();
      await expect(
        live.db.insert(schema.projectShare).values({
          ...base,
          subjectType: 'team' as never,
          subjectUserId: users[0]!,
        }),
      ).rejects.toThrow();
    });

    it('keeps a subject once per project, for people and for groups', async () => {
      await live.db.insert(schema.projectShare).values({
        projectId: projects[4]!,
        subjectType: 'person',
        subjectUserId: users[6]!,
        permission: 'viewer',
      });
      await expect(
        live.db.insert(schema.projectShare).values({
          projectId: projects[4]!,
          subjectType: 'person',
          subjectUserId: users[6]!,
          permission: 'editor',
        }),
      ).rejects.toThrow();
      await expect(
        live.db.insert(schema.projectShare).values({
          projectId: projects[4]!,
          subjectType: 'group',
          subjectGroupId: groups[2]!,
          permission: 'viewer',
        }),
      ).rejects.toThrow();
    });

    it('cascades from the project, the person and the group, and never restricts', async () => {
      const [project] = await live.db
        .insert(schema.project)
        .values({ organizationId, userId: users[0]!, name: 'Cascade' })
        .returning();
      const [group] = await live.db
        .insert(schema.group)
        .values({ organizationId, name: 'Cascade group' })
        .returning();
      const person = await seedUser(live.db, organizationId);
      const creator = await seedUser(live.db, organizationId);
      await live.db.insert(schema.projectShare).values([
        {
          projectId: project!.id,
          subjectType: 'person',
          subjectUserId: person,
          permission: 'viewer',
          createdByUserId: creator,
        },
        {
          projectId: project!.id,
          subjectType: 'group',
          subjectGroupId: group!.id,
          permission: 'editor',
        },
      ]);
      const count = async () =>
        Number(
          (
            await live.db.execute<{ n: number }>(
              sql`select count(*)::int as n from project_share where project_id = ${project!.id}`,
            )
          )[0]!.n,
        );
      expect(await count()).toBe(2);
      // The creator's account goes: the share stays (SET NULL).
      await live.db.execute(sql`delete from "user" where id = ${creator}`);
      expect(await count()).toBe(2);
      // The person goes: their share goes.
      await live.db.execute(sql`delete from "user" where id = ${person}`);
      expect(await count()).toBe(1);
      // The group goes: its share goes.
      await live.db.execute(sql`delete from "group" where id = ${group!.id}`);
      expect(await count()).toBe(0);
      // The project goes: shares go with it.
      await live.db.insert(schema.projectShare).values({
        projectId: project!.id,
        subjectType: 'person',
        subjectUserId: users[6]!,
        permission: 'viewer',
      });
      await live.db.execute(sql`delete from project where id = ${project!.id}`);
      expect(await count()).toBe(0);
    });
  });
});
