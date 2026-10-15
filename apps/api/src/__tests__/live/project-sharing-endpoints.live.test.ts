import { randomUUID } from 'node:crypto';
import { createDatabase, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { type Person, sharingHelpers } from '../../../test/project-sharing.fixtures.js';

/**
 * The sharing endpoints (v0.14, project sharing): who is found and how, every
 * refusal and its reason, the limits (counted exactly, even when requests race),
 * the rate limit (the real one), the mixed-version guard, and the audit entries.
 * Real PostgreSQL and the real routes; settings and the version heartbeats are
 * the only stubs.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  role: 'user',
  replicas: [] as Array<{ version: string }> | null,
  failReplicas: false,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/jobs/workers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/jobs/workers.js')>()),
  liveReplicas: async () => {
    if (state.failReplicas) throw new Error('Redis is down');
    return state.replicas;
  },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'storage') {
      return {
        driver: 'local',
        maxFileBytes: 1024 * 1024,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain'],
      };
    }
    if (key === 'features') return { attachments: true, temporaryChat: true };
    return {};
  },
  invalidateSettingsCache: () => {},
}));
// Everything the routes import for uploads and thread creation is allowed; the sharing
// limits (`consumeRateLimit`) are the real ones, so the rate limit is what is tested.
vi.mock('../../services/limits/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/limits/rate-limit.js')>()),
  uploadRateLimit: async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 1 }),
  threadCreateRateLimit: async () => ({
    allowed: true,
    limit: 100,
    remaining: 99,
    retryAfterSeconds: 1,
  }),
}));

const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { APP_VERSION } = await import('../../version.js');
const { isOlderRelease, assertNoOlderReplica } = await import(
  '../../services/project-sharing/upgrade-guard.js'
);

describe.skipIf(!available)('live: project sharing endpoints', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;

  const h = sharingHelpers({
    state,
    routes: { projectRoutes, threadRoutes, attachmentRoutes },
    errorHandler,
    db: () => pool.db,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('project_sharing_endpoints');
    pool = createDatabase(live.connectionString, { max: 12 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
  });
  afterEach(() => {
    state.replicas = [];
    state.failReplicas = false;
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const reason = (response: { json: { error?: { details?: { reason?: string } } } }) =>
    response.json?.error?.details?.reason;

  /** `n` people, created in one statement. */
  async function manyPeople(n: number, label: string) {
    const rows = await pool.db.execute<{ id: string; email: string }>(sql`
      insert into "user" (id, name, email, email_verified, role, organization_id)
      select gen_random_uuid()::text, ${label} || ' ' || g, ${label.toLowerCase()} || '-' || g || '-' || ${randomUUID().slice(0, 6)} || '@example.com', true, 'user', ${state.organizationId}
      from generate_series(1, ${n}) g
      returning id, email`);
    return rows.map((row) => ({ id: row.id, email: row.email, name: label }));
  }

  async function sharesOf(projectId: string) {
    const [row] = await pool.db.execute<{ n: number }>(
      sql`select count(*)::int as n from project_share where project_id = ${projectId}`,
    );
    return row!.n;
  }

  describe('who is found', () => {
    it('shares with a person by exact email, ignoring case and outer spaces, and returns the share with name and email to the owner', async () => {
      const owner = await h.person('Owner');
      const friend = await h.person('Friend');
      const project = await h.createProject(owner, 'Findable');
      const response = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: `  ${friend.email.toUpperCase()} ` },
        permission: 'viewer',
      });
      expect(response.status, response.text).toBe(201);
      expect(response.json.share).toMatchObject({
        permission: 'viewer',
        subject: { type: 'person', userId: friend.id, name: friend.name, email: friend.email },
      });
      // It appears under "Shared with me", with no notification anywhere (nothing to assert but the list).
      const shared = await h.ok(friend, 'GET', '/projects');
      expect(shared.shared.map((entry: { id: string }) => entry.id)).toEqual([project.id]);
      expect(shared.shared[0]).toMatchObject({ access: 'viewer', ownerName: owner.name });
      expect(shared.projects).toEqual([]);
    });

    it('does not guess: a part of an email, a name or another domain finds nobody', async () => {
      const owner = await h.person('Owner');
      const friend = await h.person('Friend');
      const project = await h.createProject(owner, 'Exact only');
      for (const email of [
        friend.email.slice(1),
        `${friend.email.split('@')[0]}@example.org`,
        `%${friend.email}`,
        `${friend.email.split('@')[0]}%`,
      ]) {
        const response = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
          subject: { type: 'person', email },
          permission: 'viewer',
        });
        expect(response.status, email).toBe(422);
        // A well-formed address nobody has is person_not_found; a pattern is not even an address.
        expect(['person_not_found', undefined], email).toContain(reason(response));
      }
      expect(await sharesOf(project.id)).toBe(0);
    });

    it('refuses the owner themselves, a duplicate, a group the owner is not in, and an unknown group alike', async () => {
      const owner = await h.person('Owner');
      const friend = await h.person('Friend');
      const outsider = await h.person('Outsider');
      const project = await h.createProject(owner, 'Refusals');
      const own = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: owner.email },
        permission: 'editor',
      });
      expect([own.status, reason(own)]).toEqual([422, 'cannot_share_with_self']);

      await h.shareWith(owner, project.id, friend, 'viewer');
      const twice = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: friend.email },
        permission: 'editor',
      });
      expect([twice.status, reason(twice)]).toEqual([409, 'already_shared']);

      const foreign = await h.makeGroup('Foreign', [outsider]);
      const notMine = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'group', groupId: foreign },
        permission: 'viewer',
      });
      const unknown = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'group', groupId: randomUUID() },
        permission: 'viewer',
      });
      // The same answer: nothing says whether a group exists.
      expect([notMine.status, reason(notMine), notMine.json.error.message]).toEqual([
        422,
        'not_a_group_member',
        unknown.json.error.message,
      ]);
      expect([unknown.status, reason(unknown)]).toEqual([422, 'not_a_group_member']);

      const mine = await h.makeGroup('Mine', [owner]);
      await h.shareWithGroup(owner, project.id, mine, 'viewer');
      const again = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'group', groupId: mine },
        permission: 'editor',
      });
      expect([again.status, reason(again)]).toEqual([409, 'already_shared']);
      expect(await sharesOf(project.id)).toBe(2);
    });

    it('rejects malformed bodies without touching anything', async () => {
      const owner = await h.person('Owner');
      const project = await h.createProject(owner, 'Bodies');
      for (const body of [
        {},
        { permission: 'viewer' },
        { subject: { type: 'person', email: 'not-an-email' }, permission: 'viewer' },
        { subject: { type: 'person', email: 'a@example.com' }, permission: 'owner' },
        { subject: { type: 'team', id: 'x' }, permission: 'viewer' },
        { subject: { type: 'person', email: 'a@example.com', userId: 'x' }, permission: 'viewer' },
        { subject: { type: 'group' }, permission: 'viewer' },
      ]) {
        const response = await h.call(owner, 'POST', `/projects/${project.id}/shares`, body);
        expect(response.status, JSON.stringify(body)).toBe(422);
      }
      expect(
        (
          await h.call(owner, 'PATCH', `/projects/${project.id}/shares/${randomUUID()}`, {
            permission: 'owner',
          })
        ).status,
      ).toBe(422);
      expect((await h.call(owner, 'POST', `/projects/${project.id}/transfer`, {})).status).toBe(
        422,
      );
      expect(await sharesOf(project.id)).toBe(0);
    });

    it('answers 404 for a share that is not on this project, even to the owner of both', async () => {
      const owner = await h.person('Owner');
      const friend = await h.person('Friend');
      const a = await h.createProject(owner, 'A');
      const b = await h.createProject(owner, 'B');
      const share = await h.shareWith(owner, a.id, friend, 'viewer');
      expect(
        (
          await h.call(owner, 'PATCH', `/projects/${b.id}/shares/${share.id}`, {
            permission: 'editor',
          })
        ).status,
      ).toBe(404);
      expect((await h.call(owner, 'DELETE', `/projects/${b.id}/shares/${share.id}`)).status).toBe(
        404,
      );
      expect(await sharesOf(a.id)).toBe(1);
    });

    it('lists shares with people’s names and emails and groups’ sizes for the owner only', async () => {
      const owner = await h.person('Owner');
      const friend = await h.person('Friend');
      const project = await h.createProject(owner, 'Listed');
      const group = await h.makeGroup('Listed group', [
        owner,
        await h.person('M1'),
        await h.person('M2'),
      ]);
      await h.shareWith(owner, project.id, friend, 'editor');
      await h.shareWithGroup(owner, project.id, group, 'viewer');
      const listed = await h.ok(owner, 'GET', `/projects/${project.id}/shares`);
      expect(listed.shares).toHaveLength(2);
      expect(listed.shares[0].subject).toMatchObject({ type: 'person', email: friend.email });
      expect(listed.shares[1].subject).toMatchObject({
        type: 'group',
        groupId: group,
        memberCount: 3,
      });
      expect((await h.call(friend, 'GET', `/projects/${project.id}/shares`)).status).toBe(403);
      const info = await h.ok(friend, 'GET', `/projects/${project.id}/access`);
      expect(info).toEqual({
        access: 'editor',
        ownerName: owner.name,
        personShares: 1,
        groupShares: 1,
        canLeave: true,
      });
    });
  });

  describe('outsiders learn nothing', () => {
    it('answers 404 on every route of a project, to a person with no access and for an id that does not exist', async () => {
      const owner = await h.person('Owner');
      const outsider = await h.person('Outsider');
      const project = await h.createProject(owner, 'Private');
      const shareId = randomUUID();
      const routes: Array<[string, string, unknown?]> = [
        ['GET', ''],
        ['PATCH', '', { instructions: 'x' }],
        ['DELETE', ''],
        ['GET', '/files'],
        ['DELETE', `/files/${randomUUID()}`],
        ['GET', '/access'],
        ['GET', '/shares'],
        [
          'POST',
          '/shares',
          { subject: { type: 'person', email: owner.email }, permission: 'viewer' },
        ],
        ['PATCH', `/shares/${shareId}`, { permission: 'viewer' }],
        ['DELETE', `/shares/${shareId}`],
        ['POST', '/transfer', { email: owner.email }],
        ['POST', '/leave'],
      ];
      for (const id of [project.id, randomUUID()]) {
        for (const [method, suffix, body] of routes) {
          const response = await h.call(outsider, method, `/projects/${id}${suffix}`, body);
          expect([response.status, response.json?.error?.message], `${method} ${suffix}`).toEqual([
            404,
            'Project not found',
          ]);
        }
      }
      const move = await h.call(outsider, 'POST', '/threads', {
        title: 'x',
        projectId: project.id,
      });
      expect(move.status).toBe(404);
    });
  });

  describe('limits', () => {
    it('allows at most 50 shares on a project (a group counts one) and says the number', async () => {
      const owner = await h.person('Owner');
      const project = await h.createProject(owner, 'Crowded');
      const crowd = await manyPeople(49, 'Crowd');
      await pool.db.insert(schema.projectShare).values(
        crowd.map((person) => ({
          projectId: project.id,
          subjectType: 'person' as const,
          subjectUserId: person.id,
          permission: 'viewer' as const,
        })),
      );
      const group = await h.makeGroup('Big group', [owner, ...(await manyPeople(30, 'Member'))]);
      // The 50th is a group of 31 people: it counts one.
      await h.shareWithGroup(owner, project.id, group, 'viewer');
      expect(await sharesOf(project.id)).toBe(50);
      const extra = await h.person('Extra');
      const refused = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: extra.email },
        permission: 'viewer',
      });
      expect([refused.status, reason(refused)]).toEqual([422, 'share_limit']);
      expect(refused.json.error.message).toContain('50');
      expect(await sharesOf(project.id)).toBe(50);
    });

    it('holds the limit under racing requests: exactly the room that is left is filled', async () => {
      const owner = await h.person('Owner');
      const project = await h.createProject(owner, 'Race for room');
      const crowd = await manyPeople(45, 'Seated');
      await pool.db.insert(schema.projectShare).values(
        crowd.map((person) => ({
          projectId: project.id,
          subjectType: 'person' as const,
          subjectUserId: person.id,
          permission: 'viewer' as const,
        })),
      );
      const late = await manyPeople(10, 'Late');
      const results = await Promise.all(
        late.map((person) =>
          h.call(owner, 'POST', `/projects/${project.id}/shares`, {
            subject: { type: 'person', email: person.email },
            permission: 'viewer',
          }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => reason(r) === 'share_limit')).toHaveLength(5);
      expect(await sharesOf(project.id)).toBe(50);
    });

    it('allows a person at most 100 direct inbound shares, exactly, under racing requests', async () => {
      const target = await h.person('Popular');
      const owners = await manyPeople(100, 'Sharer');
      const projects = await pool.db
        .insert(schema.project)
        .values(
          owners.map((person, index) => ({
            organizationId: state.organizationId,
            userId: person.id,
            name: `Inbound ${index}`,
          })),
        )
        .returning({ id: schema.project.id });
      await pool.db.insert(schema.projectShare).values(
        projects.slice(0, 95).map((project) => ({
          projectId: project.id,
          subjectType: 'person' as const,
          subjectUserId: target.id,
          permission: 'viewer' as const,
        })),
      );
      // Five more from five owners at once fill it; a sixth is refused.
      const racing = await Promise.all(
        [95, 96, 97, 98, 99].map((index) =>
          h.call(owners[index] as Person, 'POST', `/projects/${projects[index]!.id}/shares`, {
            subject: { type: 'person', email: target.email },
            permission: 'viewer',
          }),
        ),
      );
      expect(racing.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const sixth = await h.person('Sixth');
      const project = await h.createProject(sixth, 'One too many');
      const refused = await h.call(sixth, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: target.email },
        permission: 'viewer',
      });
      expect([refused.status, reason(refused)]).toEqual([422, 'inbound_limit']);
      expect(refused.json.error.message).toContain('100');
      // The sidebar lists at most 100 shared projects.
      const sidebar = await h.ok(target, 'GET', '/projects/sidebar');
      expect(sidebar.shared).toHaveLength(100);
      expect((await h.ok(target, 'GET', '/projects')).shared).toHaveLength(100);
    });
  });

  describe('the rate limit', () => {
    it('lets a person look up and share 30 times a minute and then answers 429 with Retry-After', async () => {
      const owner = await h.person('Hurried');
      const project = await h.createProject(owner, 'Hurry');
      for (let i = 0; i < 30; i += 1) {
        const response = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
          subject: { type: 'person', email: `nobody-${i}@example.com` },
          permission: 'viewer',
        });
        expect(response.status, `request ${i + 1}`).toBe(422);
      }
      const limited = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: 'nobody-31@example.com' },
        permission: 'viewer',
      });
      expect(limited.status).toBe(429);
      expect(limited.json.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      // Someone else is unaffected, and so are reads.
      const calm = await h.person('Calm');
      const calmProject = await h.createProject(calm, 'Calm');
      expect(
        (
          await h.call(calm, 'POST', `/projects/${calmProject.id}/shares`, {
            subject: { type: 'person', email: 'nobody@example.com' },
            permission: 'viewer',
          })
        ).status,
      ).toBe(422);
      expect((await h.call(owner, 'GET', `/projects/${project.id}/shares`)).status).toBe(200);
    });
  });

  describe('the mixed-version guard', () => {
    it('refuses to create a share or transfer while a replica of an older release is live, and allows everything else', async () => {
      const owner = await h.person('Owner');
      const editor = await h.person('Editor');
      const viewer = await h.person('Viewer');
      const project = await h.createProject(owner, 'Upgrading');
      const editorShare = await h.shareWith(owner, project.id, editor, 'editor');
      const viewerShare = await h.shareWith(owner, project.id, viewer, 'viewer');
      state.replicas = [{ version: APP_VERSION }, { version: '0.12.9' }];

      const newcomer = await h.person('Newcomer');
      const create = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: newcomer.email },
        permission: 'viewer',
      });
      expect([create.status, reason(create)]).toEqual([409, 'upgrade_in_progress']);
      expect(create.json.error.message).toBe(
        'An upgrade is still in progress. Try again when it has finished.',
      );
      expect(await sharesOf(project.id)).toBe(2);
      const transfer = await h.call(owner, 'POST', `/projects/${project.id}/transfer`, {
        email: editor.email,
      });
      expect([transfer.status, reason(transfer)]).toEqual([409, 'upgrade_in_progress']);

      // Everything that cannot create new exposure still works.
      expect(
        (
          await h.call(owner, 'PATCH', `/projects/${project.id}/shares/${viewerShare.id}`, {
            permission: 'editor',
          })
        ).status,
      ).toBe(200);
      expect((await h.call(owner, 'GET', `/projects/${project.id}/shares`)).status).toBe(200);
      expect((await h.call(viewer, 'POST', `/projects/${project.id}/leave`)).status).toBe(200);
      expect(
        (await h.call(owner, 'DELETE', `/projects/${project.id}/shares/${editorShare.id}`)).status,
      ).toBe(200);
      expect((await h.call(owner, 'GET', `/projects/${project.id}`)).status).toBe(200);

      // Once every replica runs this release it goes through.
      state.replicas = [{ version: APP_VERSION }];
      expect(
        (
          await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
            subject: { type: 'person', email: newcomer.email },
            permission: 'viewer',
          })
        ).status,
      ).toBe(201);
    });

    it('lets it through with one replica and no Redis (no heartbeats), with nobody heard from yet, and with a newer replica', async () => {
      const owner = await h.person('Owner');
      const project = await h.createProject(owner, 'Alone');
      const people = [
        await h.person('A'),
        await h.person('B'),
        await h.person('C'),
        await h.person('D'),
      ];
      const cases: Array<Array<{ version: string }> | null> = [
        null,
        [],
        [{ version: '99.0.0' }, { version: APP_VERSION }],
      ];
      for (const [index, replicas] of cases.entries()) {
        state.replicas = replicas;
        const response = await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
          subject: { type: 'person', email: people[index]!.email },
          permission: 'viewer',
        });
        expect(response.status, JSON.stringify(replicas)).toBe(201);
      }
      // Redis configured but unreachable: no evidence is no block.
      state.failReplicas = true;
      expect(
        (
          await h.call(owner, 'POST', `/projects/${project.id}/shares`, {
            subject: { type: 'person', email: people[3]!.email },
            permission: 'viewer',
          })
        ).status,
      ).toBe(201);
    });

    it('does not let a person with no access learn that an upgrade is running', async () => {
      const owner = await h.person('Owner');
      const outsider = await h.person('Outsider');
      const project = await h.createProject(owner, 'Hidden');
      state.replicas = [{ version: '0.1.0' }];
      const response = await h.call(outsider, 'POST', `/projects/${project.id}/shares`, {
        subject: { type: 'person', email: owner.email },
        permission: 'viewer',
      });
      expect(response.status).toBe(404);
    });

    it('reads releases as numbers, and an unreadable different version counts as older', () => {
      expect(isOlderRelease('0.13.1', '0.14.0')).toBe(true);
      expect(isOlderRelease('0.9.9', '0.14.0')).toBe(true);
      expect(isOlderRelease('0.14.0', '0.14.0')).toBe(false);
      expect(isOlderRelease('v0.14.0', '0.14.0')).toBe(false);
      expect(isOlderRelease('0.14.1', '0.14.0')).toBe(false);
      expect(isOlderRelease('1.0.0', '0.14.0')).toBe(false);
      expect(isOlderRelease('0.14.0-rc1', '0.14.0')).toBe(false);
      expect(isOlderRelease('dev-abc123', '0.14.0')).toBe(true);
      expect(isOlderRelease('dev-abc123', 'dev-abc123')).toBe(false);
      expect(isOlderRelease('0.14.0', 'dev-abc123')).toBe(true);
    });

    it('can be used directly with a heartbeat list (for the groups module)', async () => {
      await expect(
        assertNoOlderReplica(async () => [{ version: '0.13.1' }], '0.14.0'),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        assertNoOlderReplica(async () => [{ version: '0.14.0' }], '0.14.0'),
      ).resolves.toBeUndefined();
      await expect(assertNoOlderReplica(async () => null, '0.14.0')).resolves.toBeUndefined();
      await expect(
        assertNoOlderReplica(async () => {
          throw new Error('x');
        }, '0.14.0'),
      ).resolves.toBeUndefined();
    });
  });

  describe('audit', () => {
    it('records create, update and delete with the subject and permission, never the project’s name or content', async () => {
      const owner = await h.person('Auditor-owner');
      const friend = await h.person('Friend');
      const project = await h.createProject(
        owner,
        'Secret codename Bluebird',
        'Secret instructions Bluebird',
      );
      const share = await h.shareWith(owner, project.id, friend, 'viewer');
      await h.ok(owner, 'PATCH', `/projects/${project.id}/shares/${share.id}`, {
        permission: 'editor',
      });
      await h.ok(owner, 'DELETE', `/projects/${project.id}/shares/${share.id}`);
      const [created] = await h.auditOf('project.share.create', project.id);
      expect(created).toMatchObject({
        actorUserId: owner.id,
        actorEmail: owner.email,
        targetType: 'project',
        targetId: project.id,
      });
      expect(created!.metadata).toEqual({
        subjectType: 'person',
        subjectUserId: friend.id,
        subjectEmail: friend.email,
        permission: 'viewer',
      });
      const [updated] = await h.auditOf('project.share.update', project.id);
      expect(updated!.metadata).toMatchObject({
        permission: 'editor',
        previousPermission: 'viewer',
        subjectUserId: friend.id,
      });
      const [deleted] = await h.auditOf('project.share.delete', project.id);
      expect(deleted!.metadata).toMatchObject({ subjectUserId: friend.id, permission: 'editor' });
      const everything = JSON.stringify([created, updated, deleted]);
      expect(everything).not.toContain('Bluebird');
      expect(everything).not.toContain('codename');
    });

    it('records a group share by group id', async () => {
      const owner = await h.person('Owner');
      const project = await h.createProject(owner, 'Group audit');
      const group = await h.makeGroup('Auditors', [owner]);
      await h.shareWithGroup(owner, project.id, group, 'viewer');
      const [created] = await h.auditOf('project.share.create', project.id);
      expect(created!.metadata).toEqual({
        subjectType: 'group',
        subjectGroupId: group,
        permission: 'viewer',
      });
    });
  });
});
