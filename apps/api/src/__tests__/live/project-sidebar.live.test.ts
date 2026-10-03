import type { ProjectSummary, SidebarProject, ThreadSummary } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The sidebar's data (v0.9.1) through the real routes and real PostgreSQL:
 * GET /api/projects/sidebar (each project's count and newest unpinned
 * conversations, from one lateral join) and GET /api/threads?view=sidebar
 * (the general list without project conversations, pinned ones excepted).
 * Settings and the organisation are the only stubs.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  roleFeatures: {} as Record<string, unknown>,
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'features') return { attachments: true, temporaryChat: true };
    if (key === 'roleFeatures') return state.roleFeatures;
    return {};
  },
  invalidateSettingsCache: () => {},
}));

const { inArray, schema } = await import('@oci/db');
const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
type AppBindings = import('../../middleware/context.js').AppBindings;

function appFor(userId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: `${userId}@example.com`,
      name: 'Person',
      image: null,
      role: 'user',
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api/projects', projectRoutes);
  app.route('/api/threads', threadRoutes);
  return app;
}

async function call(userId: string, method: string, path: string, body?: unknown) {
  return appFor(userId).request(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

describe.skipIf(!available)('live: the sidebar project tree and general list', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('project-sidebar');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  beforeEach(() => {
    state.roleFeatures = {};
  });

  async function person() {
    return seedUser(live.db, state.organizationId);
  }

  async function createProject(userId: string, name: string) {
    return (
      await json<{ project: ProjectSummary }>(
        await call(userId, 'POST', '/projects', { name }),
        201,
      )
    ).project;
  }

  /** Inserted directly so each row's activity time is exact. */
  async function thread(
    userId: string,
    title: string,
    minutesAgo: number,
    extra: Partial<typeof schema.thread.$inferInsert> = {},
  ) {
    const at = new Date(Date.UTC(2026, 5, 1, 12) - minutesAgo * 60_000);
    const [row] = await live.db
      .insert(schema.thread)
      .values({
        organizationId: state.organizationId,
        userId,
        title,
        createdAt: at,
        updatedAt: at,
        lastMessageAt: at,
        ...extra,
      })
      .returning();
    if (!row) throw new Error('thread not inserted');
    return row;
  }

  async function sidebar(userId: string) {
    return (
      await json<{ projects: SidebarProject[] }>(await call(userId, 'GET', '/projects/sidebar'))
    ).projects;
  }

  async function sidebarThreads(userId: string, query = '?view=sidebar') {
    return (await json<{ threads: ThreadSummary[] }>(await call(userId, 'GET', `/threads${query}`)))
      .threads;
  }

  describe('GET /api/projects/sidebar', () => {
    it('lists the five newest unpinned live conversations and counts every live one', async () => {
      const owner = await person();
      const stranger = await person();
      const project = await createProject(owner, 'Thesis');
      const inProject = { projectId: project.id };

      // Seven live unpinned conversations, the newest first by title.
      for (let index = 1; index <= 7; index += 1) {
        await thread(owner, `Live ${index}`, index * 10, inProject);
      }
      // Pinned: newest of all, counted but never in the list.
      await thread(owner, 'Pinned', 1, { ...inProject, pinned: true });
      // Excluded everywhere a live conversation would appear, and not counted.
      await thread(owner, 'Archived', 2, { ...inProject, archived: true });
      await thread(owner, 'Temporary', 3, {
        ...inProject,
        temporary: true,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await thread(owner, 'Trashed', 4, {
        ...inProject,
        deletedAt: new Date(),
        deletedReason: 'user',
      });
      // Another person's row pointing at this project is never shown or counted.
      await thread(stranger, 'Stranger', 5, inProject);
      // A conversation in no project does not belong here either.
      await thread(owner, 'Unfiled', 0);

      const [entry] = await sidebar(owner);
      expect(entry).toMatchObject({ id: project.id, name: 'Thesis', threadCount: 8 });
      expect(entry?.recentThreads.map((row) => row.title)).toEqual([
        'Live 1',
        'Live 2',
        'Live 3',
        'Live 4',
        'Live 5',
      ]);
      // Full conversation summaries, the same shape GET /api/threads returns.
      expect(entry?.recentThreads[0]).toMatchObject({
        projectId: project.id,
        pinned: false,
        archived: false,
        temporary: false,
        lastMessageAt: '2026-06-01T11:50:00.000Z',
        updatedAt: '2026-06-01T11:50:00.000Z',
      });
      // The general project summary agrees on the count.
      const summary = await json<{ project: ProjectSummary }>(
        await call(owner, 'GET', `/projects/${project.id}`),
      );
      expect(summary.project.threadCount).toBe(8);

      // Unpinning puts a conversation back under its project, newest first.
      const pinned = (await sidebarThreads(owner)).find((row) => row.title === 'Pinned');
      await json(await call(owner, 'PATCH', `/threads/${pinned?.id}`, { pinned: false }));
      const [after] = await sidebar(owner);
      expect(after?.recentThreads.map((row) => row.title)).toEqual([
        'Pinned',
        'Live 1',
        'Live 2',
        'Live 3',
        'Live 4',
      ]);
      expect(after?.threadCount).toBe(8);
    });

    it('lists every project by name, empty and pinned-only ones included', async () => {
      const owner = await person();
      const zeta = await createProject(owner, 'zeta');
      const alpha = await createProject(owner, 'Alpha');
      const middle = await createProject(owner, 'middle');
      await thread(owner, 'Only pinned', 5, { projectId: middle.id, pinned: true });
      await thread(owner, 'Zeta one', 5, { projectId: zeta.id });

      const projects = await sidebar(owner);
      expect(projects.map((project) => [project.name, project.threadCount])).toEqual([
        ['Alpha', 0],
        ['middle', 1],
        ['zeta', 1],
      ]);
      expect(projects.map((project) => project.recentThreads.length)).toEqual([0, 0, 1]);
      expect(projects[0]?.id).toBe(alpha.id);
    });

    it('keeps older conversations under their project however many newer ones exist', async () => {
      const owner = await person();
      const project = await createProject(owner, 'Old work');
      await thread(owner, 'Old project chat', 60 * 24 * 365, { projectId: project.id });
      await live.db.insert(schema.thread).values(
        Array.from({ length: 205 }, (_, index) => ({
          organizationId: state.organizationId,
          userId: owner,
          title: `Recent ${index}`,
        })),
      );

      const [entry] = await sidebar(owner);
      expect(entry?.recentThreads.map((row) => row.title)).toEqual(['Old project chat']);
    });

    it("shows nobody else's projects and needs the role's projects switch", async () => {
      const owner = await person();
      const stranger = await person();
      await createProject(owner, 'Private');
      expect(await sidebar(stranger)).toEqual([]);

      state.roleFeatures = { roles: { user: { projects: false } } };
      expect((await call(owner, 'GET', '/projects/sidebar')).status).toBe(403);
    });

    it('follows moves between projects and out of them', async () => {
      const owner = await person();
      const first = await createProject(owner, 'First');
      const second = await createProject(owner, 'Second');
      const row = await thread(owner, 'Moving', 30, { projectId: first.id });

      await json(await call(owner, 'PATCH', `/threads/${row.id}`, { projectId: second.id }));
      let projects = await sidebar(owner);
      expect(projects.map((project) => project.recentThreads.map((t) => t.title))).toEqual([
        [],
        ['Moving'],
      ]);
      expect(projects.map((project) => project.threadCount)).toEqual([0, 1]);
      expect((await sidebarThreads(owner)).map((t) => t.title)).not.toContain('Moving');

      await json(await call(owner, 'PATCH', `/threads/${row.id}`, { projectId: null }));
      projects = await sidebar(owner);
      expect(projects.map((project) => project.threadCount)).toEqual([0, 0]);
      expect((await sidebarThreads(owner)).map((t) => t.title)).toContain('Moving');
    });
  });

  describe('GET /api/threads?view=sidebar', () => {
    it('leaves out project conversations unless they are pinned', async () => {
      const owner = await person();
      const project = await createProject(owner, 'Grants');
      await thread(owner, 'Unfiled', 10);
      await thread(owner, 'In project', 5, { projectId: project.id });
      await thread(owner, 'Pinned in project', 20, { projectId: project.id, pinned: true });
      await thread(owner, 'Pinned unfiled', 30, { pinned: true });
      await thread(owner, 'Archived unfiled', 1, { archived: true });

      expect((await sidebarThreads(owner)).map((row) => row.title)).toEqual([
        'Pinned in project',
        'Pinned unfiled',
        'Unfiled',
      ]);
      // Every other caller still gets every conversation.
      expect((await sidebarThreads(owner, '')).map((row) => row.title)).toEqual([
        'Pinned in project',
        'Pinned unfiled',
        'In project',
        'Unfiled',
      ]);
      expect(
        (await sidebarThreads(owner, `?projectId=${project.id}`)).map((row) => row.title),
      ).toEqual(['Pinned in project', 'In project']);
    });

    it('keeps the 200-row limit, pinned first', async () => {
      const owner = await person();
      const project = await createProject(owner, 'Busy');
      await thread(owner, 'Pinned old', 60 * 24 * 30, { projectId: project.id, pinned: true });
      const inserted = await live.db
        .insert(schema.thread)
        .values(
          Array.from({ length: 205 }, (_, index) => ({
            organizationId: state.organizationId,
            userId: owner,
            title: `Unfiled ${index}`,
            projectId: index % 2 === 0 ? project.id : null,
          })),
        )
        .returning({ id: schema.thread.id });
      expect(inserted).toHaveLength(205);

      const threads = await sidebarThreads(owner);
      // 102 unfiled plus the pinned one: under the limit once project ones go.
      expect(threads).toHaveLength(103);
      expect(threads[0]?.title).toBe('Pinned old');
      expect(threads.filter((row) => row.projectId && !row.pinned)).toEqual([]);

      await live.db
        .update(schema.thread)
        .set({ projectId: null })
        .where(
          inArray(
            schema.thread.id,
            inserted.map((row) => row.id),
          ),
        );
      const all = await sidebarThreads(owner);
      expect(all).toHaveLength(200);
      expect(all[0]?.title).toBe('Pinned old');
    });

    it('keeps project conversations in the list for a role without projects', async () => {
      const owner = await person();
      const project = await createProject(owner, 'Switched off');
      await thread(owner, 'In project', 5, { projectId: project.id });

      state.roleFeatures = { roles: { user: { projects: false } } };
      expect((await sidebarThreads(owner)).map((row) => row.title)).toEqual(['In project']);
    });

    it('refuses an unknown view', async () => {
      const owner = await person();
      expect((await call(owner, 'GET', '/threads?view=everything')).status).toBe(422);
    });
  });

  describe('GET /api/threads?view=history (Settings → History, v0.9.1)', () => {
    type Page = { threads: ThreadSummary[]; nextCursor: string | null };

    /** `count` live conversations with distinct update times, plus ties. */
    async function seedHistory(userId: string, count: number) {
      const base = Date.UTC(2026, 0, 1);
      const rows = Array.from({ length: count }, (_, index) => ({
        organizationId: state.organizationId,
        userId,
        title: index % 10 === 0 ? `Budget review ${index}` : `Conversation ${index}`,
        // Pairs share an update time, so the id must break the tie.
        updatedAt: new Date(base + Math.floor(index / 2) * 1000 + 0.4),
        pinned: index === count - 1,
      }));
      await live.db.insert(schema.thread).values(rows);
    }

    async function allPages(userId: string, query: string) {
      const seen: ThreadSummary[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const suffix: string = cursor ? `&before=${encodeURIComponent(cursor)}` : '';
        const page: Page = await json<Page>(
          await call(userId, 'GET', `/threads?view=history${query}${suffix}`),
        );
        seen.push(...page.threads);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 50);
      return { seen, pages };
    }

    it('pages past 200 conversations without gaps, repeats or pinned-first ordering', async () => {
      const userId = await person();
      await seedHistory(userId, 230);
      const first = await json<Page>(await call(userId, 'GET', '/threads?view=history&limit=100'));
      expect(first.threads).toHaveLength(100);
      expect(first.nextCursor).toEqual(expect.any(String));
      // Newest activity first (229 and 228 tie, so the id orders them); the
      // pinned conversation (229) is not hoisted for being pinned.
      expect(
        first.threads
          .slice(0, 2)
          .map((thread) => thread.title)
          .sort(),
      ).toEqual(['Conversation 228', 'Conversation 229']);

      const { seen, pages } = await allPages(userId, '&limit=100');
      expect(pages).toBe(3);
      expect(seen).toHaveLength(230);
      expect(new Set(seen.map((thread) => thread.id)).size).toBe(230);
      const times = seen.map((thread) => new Date(thread.updatedAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      // The default page is 50, and the sidebar list is unchanged (pinned first, 200 rows).
      expect(
        (await json<Page>(await call(userId, 'GET', '/threads?view=history'))).threads,
      ).toHaveLength(50);
      const plain = await json<Page>(await call(userId, 'GET', '/threads'));
      expect(plain.threads).toHaveLength(200);
      expect(plain.threads[0]?.pinned).toBe(true);
      expect(plain.nextCursor).toBeUndefined();
    });

    it('searches titles across every page, and keeps archived apart', async () => {
      const userId = await person();
      await seedHistory(userId, 120);
      await live.db.insert(schema.thread).values({
        organizationId: state.organizationId,
        userId,
        title: 'Budget review archived',
        archived: true,
      });
      const { seen } = await allPages(userId, `&limit=5&search=${encodeURIComponent('budget')}`);
      expect(seen.map((thread) => thread.title)).toHaveLength(12);
      expect(seen.every((thread) => thread.title.startsWith('Budget review'))).toBe(true);
      expect(seen.some((thread) => thread.archived)).toBe(false);
      const archived = await json<Page>(
        await call(userId, 'GET', '/threads?view=history&archived=true'),
      );
      expect(archived.threads.map((thread) => thread.title)).toEqual(['Budget review archived']);
      expect(archived.nextCursor).toBeNull();
    });

    it('lists only the caller’s conversations and refuses a forged cursor', async () => {
      const owner = await person();
      const other = await person();
      await seedHistory(owner, 3);
      expect((await json<Page>(await call(other, 'GET', '/threads?view=history'))).threads).toEqual(
        [],
      );
      expect((await call(owner, 'GET', '/threads?view=history&before=nonsense')).status).toBe(422);
      expect((await call(owner, 'GET', '/threads?view=history&limit=500')).status).toBe(422);
    });
  });
});
