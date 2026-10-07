import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectFile, ProjectSummary, ThreadSummary } from '@oci/shared';
import { strFromU8, unzipSync } from 'fflate';
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
 * Projects through the real routes, real PostgreSQL (including migration 0024's
 * constraints and the attachment delete triggers) and real local storage.
 * Settings, the organisation and rate limiting are the only stubs.
 */
const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-projects-'));

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  role: 'user' as 'admin' | 'user' | 'restricted',
  attachments: true,
  roleFeatures: {} as Record<string, unknown>,
  retention: {} as Record<string, unknown>,
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
vi.mock('../../services/limits/rate-limit.js', () => {
  const allowed = async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 1 });
  return { consumeRateLimit: allowed, uploadRateLimit: allowed, threadCreateRateLimit: allowed };
});
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'storage') {
      return {
        driver: 'local',
        maxFileBytes: 10 * 1024 * 1024,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain', 'text/markdown'],
        s3: {
          bucket: '',
          region: 'us-east-1',
          endpoint: null,
          accessKeyId: '',
          encryptedSecretAccessKey: null,
          forcePathStyle: false,
        },
      };
    }
    if (key === 'features') return { attachments: state.attachments, temporaryChat: true };
    if (key === 'roleFeatures') return state.roleFeatures;
    if (key === 'retention') return state.retention;
    return {};
  },
  invalidateSettingsCache: () => {},
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), STORAGE_LOCAL_PATH: storageRoot }) };
});

const { and, eq, schema, sql } = await import('@oci/db');
const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
const { drainDeletedObjects, reconcileStorage } = await import('../../services/storage/reaper.js');
const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
const { uploadProjectFile } = await import('../../services/projects.js');
const { applyThreadRetention } = await import('../../services/lifecycle/retention.js');
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
      role: state.role,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api/projects', projectRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/me', portabilityRoutes);
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

function form(files: Array<{ name: string; body: string }>): FormData {
  const data = new FormData();
  for (const file of files) {
    data.append('files', new File([file.body], file.name, { type: 'text/plain' }));
  }
  return data;
}

async function uploadTo(userId: string, projectId: string, name: string, body: string) {
  return appFor(userId).request(`/api/projects/${projectId}/files`, {
    method: 'POST',
    body: form([{ name, body }]),
  });
}

describe.skipIf(!available)('live: projects', () => {
  let live: LiveDatabase;
  let owner: string;
  let stranger: string;

  async function createProject(userId: string, name: string, instructions = '') {
    const body = await json<{ project: ProjectSummary }>(
      await call(userId, 'POST', '/projects', { name, instructions }),
      201,
    );
    return body.project;
  }

  async function createThread(userId: string, extra: Record<string, unknown> = {}) {
    const body = await json<{ thread: ThreadSummary }>(
      await call(userId, 'POST', '/threads', { title: 'A conversation', ...extra }),
      201,
    );
    return body.thread;
  }

  async function usage(userId: string) {
    const [row] = await live.db
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, userId));
    return { bytes: Number(row?.liveBytes ?? 0), files: Number(row?.liveFileCount ?? 0) };
  }

  beforeAll(async () => {
    live = await createLiveDatabase('projects');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    owner = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    stranger = await seedUser(live.db, state.organizationId, { email: 'stranger@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.role = 'user';
    state.attachments = true;
    state.roleFeatures = {};
    state.retention = {};
  });

  describe('create, read, update and delete', () => {
    it('manages a project and keeps it private to its owner', async () => {
      const created = await createProject(owner, '  Thesis  ', 'Cite sources in APA style.');
      expect(created).toMatchObject({
        name: 'Thesis',
        instructions: 'Cite sources in APA style.',
        fileCount: 0,
        threadCount: 0,
      });

      const list = await json<{ projects: ProjectSummary[] }>(
        await call(owner, 'GET', '/projects'),
      );
      expect(list.projects.map((project) => project.id)).toContain(created.id);
      expect(
        (await json<{ projects: ProjectSummary[] }>(await call(stranger, 'GET', '/projects')))
          .projects,
      ).toEqual([]);

      const updated = await json<{ project: ProjectSummary }>(
        await call(owner, 'PATCH', `/projects/${created.id}`, { name: 'Thesis 2026' }),
      );
      expect(updated.project).toMatchObject({
        name: 'Thesis 2026',
        instructions: 'Cite sources in APA style.',
      });
      expect(
        (
          await json<{ project: ProjectSummary }>(
            await call(owner, 'GET', `/projects/${created.id}`),
          )
        ).project.name,
      ).toBe('Thesis 2026');

      // Another person sees a missing project, never a forbidden one.
      for (const [method, path, body] of [
        ['GET', `/projects/${created.id}`, undefined],
        ['PATCH', `/projects/${created.id}`, { name: 'Mine now' }],
        ['DELETE', `/projects/${created.id}`, undefined],
        ['GET', `/projects/${created.id}/files`, undefined],
        ['GET', `/threads?projectId=${created.id}`, undefined],
      ] as const) {
        expect((await call(stranger, method, path, body)).status, `${method} ${path}`).toBe(404);
      }
      expect((await uploadTo(stranger, created.id, 'x.txt', 'stranger bytes')).status).toBe(404);

      const removed = await json<{ ok: boolean }>(
        await call(owner, 'DELETE', `/projects/${created.id}`),
      );
      expect(removed.ok).toBe(true);
      expect((await call(owner, 'GET', `/projects/${created.id}`)).status).toBe(404);
    });

    it.each([
      ['an empty name', { name: '   ' }],
      ['a name over 100 characters', { name: 'n'.repeat(101) }],
      ['instructions over 8000 characters', { name: 'Long', instructions: 'i'.repeat(8001) }],
      ['an unknown field', { name: 'Ok', color: 'red' }],
    ])('rejects %s', async (_label, body) => {
      expect((await call(owner, 'POST', '/projects', body)).status).toBe(422);
    });

    it('enforces the length limits in the database too', async () => {
      await expect(
        live.db.insert(schema.project).values({
          organizationId: state.organizationId,
          userId: owner,
          name: 'x'.repeat(101),
        }),
      ).rejects.toThrow();
    });
  });

  describe('limits', () => {
    it('allows at most 100 projects per person', async () => {
      const person = await seedUser(live.db, state.organizationId);
      await live.db.insert(schema.project).values(
        Array.from({ length: 99 }, (_, index) => ({
          organizationId: state.organizationId,
          userId: person,
          name: `Project ${index}`,
        })),
      );
      await createProject(person, 'The hundredth');
      const refused = await call(person, 'POST', '/projects', { name: 'One too many' });
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain('at most 100 projects');
      // Other people are unaffected.
      await createProject(owner, 'Still fine');
    });

    it('allows at most 20 files per project, counting against storage', async () => {
      const project = await createProject(owner, 'Many files');
      const before = await usage(owner);
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await uploadTo(owner, project.id, `file-${index}.txt`, `body ${index}`)).status,
        ).toBe(201);
      }
      const refused = await uploadTo(owner, project.id, 'extra.txt', 'one too many');
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain('at most 20 files');

      const after = await usage(owner);
      expect(after.files - before.files).toBe(20);
      const summary = await json<{ project: ProjectSummary }>(
        await call(owner, 'GET', `/projects/${project.id}`),
      );
      expect(summary.project.fileCount).toBe(20);
      await json(await call(owner, 'DELETE', `/projects/${project.id}`));
      expect(await usage(owner)).toEqual(before);
    });

    it('counts project files against the storage allowance', async () => {
      const person = await seedUser(live.db, state.organizationId);
      await live.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'restricted',
        maxTotalBytes: 10,
        enabled: true,
      });
      try {
        state.role = 'restricted';
        state.roleFeatures = { roles: { restricted: { projects: true, attachments: true } } };
        const project = await createProject(person, 'Tight');
        expect((await uploadTo(person, project.id, 'small.txt', '12345')).status).toBe(201);
        const refused = await uploadTo(person, project.id, 'big.txt', '1234567890');
        expect(refused.status).toBe(422);
      } finally {
        await live.db
          .delete(schema.storagePolicy)
          .where(eq(schema.storagePolicy.role, 'restricted'));
      }
    });
  });

  describe('role switch', () => {
    it('refuses every project route with the role wording but keeps the data', async () => {
      const project = await createProject(owner, 'Kept');
      const thread = await createThread(owner, { projectId: project.id });
      state.roleFeatures = { roles: { user: { projects: false } } };

      for (const [method, path, body] of [
        ['GET', '/projects', undefined],
        ['POST', '/projects', { name: 'New' }],
        ['GET', `/projects/${project.id}`, undefined],
        ['PATCH', `/projects/${project.id}`, { name: 'Renamed' }],
        ['DELETE', `/projects/${project.id}`, undefined],
        ['GET', `/projects/${project.id}/files`, undefined],
        ['DELETE', `/projects/${project.id}/files/anything`, undefined],
        ['GET', `/threads?projectId=${project.id}`, undefined],
        ['POST', '/threads', { projectId: project.id }],
        ['PATCH', `/threads/${thread.id}`, { projectId: null }],
      ] as const) {
        const response = await call(owner, method, path, body);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.text()).toContain('Projects are not available for your role');
      }
      expect((await uploadTo(owner, project.id, 'x.txt', 'bytes')).status).toBe(403);

      // Ordinary conversations still work, and nothing was removed.
      expect((await call(owner, 'GET', '/threads')).status).toBe(200);
      await createThread(owner);
      const [row] = await live.db
        .select()
        .from(schema.project)
        .where(eq(schema.project.id, project.id));
      expect(row?.name).toBe('Kept');
      const [stored] = await live.db
        .select({ projectId: schema.thread.projectId })
        .from(schema.thread)
        .where(eq(schema.thread.id, thread.id));
      expect(stored?.projectId).toBe(project.id);
    });

    it('is off for restricted accounts by default', async () => {
      state.role = 'restricted';
      expect((await call(owner, 'GET', '/projects')).status).toBe(403);
    });
  });

  describe('conversations in a project', () => {
    it('creates, lists and moves conversations only between the owner’s own', async () => {
      const project = await createProject(owner, 'Research');
      const other = await createProject(stranger, 'Not yours');
      const inProject = await createThread(owner, { projectId: project.id });
      expect(inProject.projectId).toBe(project.id);
      const loose = await createThread(owner);
      expect(loose.projectId).toBeNull();

      // Starting a conversation in someone else's project is a 404.
      expect((await call(owner, 'POST', '/threads', { projectId: other.id })).status).toBe(404);
      expect(
        (await call(owner, 'POST', '/threads', { projectId: project.id, temporary: true })).status,
      ).toBe(422);

      const moved = await json<{ thread: ThreadSummary }>(
        await call(owner, 'PATCH', `/threads/${loose.id}`, { projectId: project.id }),
      );
      expect(moved.thread.projectId).toBe(project.id);

      const listed = await json<{ threads: ThreadSummary[] }>(
        await call(owner, 'GET', `/threads?projectId=${project.id}`),
      );
      expect(listed.threads.map((thread) => thread.id).sort()).toEqual(
        [inProject.id, loose.id].sort(),
      );
      const all = await json<{ threads: ThreadSummary[] }>(await call(owner, 'GET', '/threads'));
      expect(all.threads.find((thread) => thread.id === loose.id)?.projectId).toBe(project.id);
      expect(
        (
          await json<{ project: ProjectSummary }>(
            await call(owner, 'GET', `/projects/${project.id}`),
          )
        ).project.threadCount,
      ).toBe(2);

      // Into someone else's project, or someone else's conversation: 404.
      expect(
        (await call(owner, 'PATCH', `/threads/${loose.id}`, { projectId: other.id })).status,
      ).toBe(404);
      expect(
        (await call(stranger, 'PATCH', `/threads/${loose.id}`, { projectId: other.id })).status,
      ).toBe(404);
      const [unchanged] = await live.db
        .select({ projectId: schema.thread.projectId })
        .from(schema.thread)
        .where(eq(schema.thread.id, loose.id));
      expect(unchanged?.projectId).toBe(project.id);

      // A title change alongside a move applies both.
      const out = await json<{ thread: ThreadSummary }>(
        await call(owner, 'PATCH', `/threads/${loose.id}`, { projectId: null, title: 'Loose' }),
      );
      expect(out.thread).toMatchObject({ projectId: null, title: 'Loose' });
    });

    it('keeps temporary chats out of projects', async () => {
      const project = await createProject(owner, 'No temporary chats');
      const [temporary] = await live.db
        .insert(schema.thread)
        .values({
          organizationId: state.organizationId,
          userId: owner,
          temporary: true,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning();
      expect(
        (await call(owner, 'PATCH', `/threads/${temporary!.id}`, { projectId: project.id })).status,
      ).toBe(422);
    });

    it('keeps forks in the source conversation’s project', async () => {
      const project = await createProject(owner, 'Forks');
      const thread = await createThread(owner, { projectId: project.id });
      const [message] = await live.db
        .insert(schema.message)
        .values({
          threadId: thread.id,
          userId: owner,
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        })
        .returning();
      const { forkFromMessage } = await import('../../services/threads.js');
      const fork = await forkFromMessage(thread.id, owner, { messageId: message!.id });
      expect(fork.projectId).toBe(project.id);
    });
  });

  describe('files', () => {
    it('uploads, lists, serves and removes a file, releasing its storage', async () => {
      const project = await createProject(owner, 'Files');
      const before = await usage(owner);
      const uploaded = await json<{ files: ProjectFile[] }>(
        await uploadTo(owner, project.id, 'brief.txt', 'The brief says hello.'),
        201,
      );
      const file = uploaded.files[0]!;
      // Chunked for search as part of the upload.
      expect(file).toMatchObject({
        filename: 'brief.txt',
        mimeType: 'text/plain',
        index: { status: 'indexed', passages: 1, truncated: false },
      });
      expect(await usage(owner)).toEqual({
        bytes: before.bytes + Buffer.byteLength('The brief says hello.'),
        files: before.files + 1,
      });

      const listed = await json<{ files: ProjectFile[] }>(
        await call(owner, 'GET', `/projects/${project.id}/files`),
      );
      expect(listed.files.map((entry) => entry.id)).toEqual([file.id]);
      expect(listed.files[0]?.index).toEqual({ status: 'indexed', passages: 1, truncated: false });

      const [row] = await live.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, file.id));
      expect(row).toMatchObject({
        projectId: project.id,
        messageId: null,
        extractedText: 'The brief says hello.',
      });

      // Served through the ordinary owner-checked content route.
      const content = await appFor(owner).request(`/api/attachments/${file.id}/content`);
      expect(content.status).toBe(200);
      expect(await content.text()).toBe('The brief says hello.');
      expect((await appFor(stranger).request(`/api/attachments/${file.id}/content`)).status).toBe(
        404,
      );

      // Listed in Settings "Attachments" with its project (v0.9.1), but not
      // deletable as a loose upload: it is removed through its project.
      const attachments = await json<{
        attachments: Array<{ id: string; project: { id: string; name: string } | null }>;
      }>(await call(owner, 'GET', '/attachments'));
      expect(attachments.attachments.find((entry) => entry.id === file.id)?.project).toEqual({
        id: project.id,
        name: project.name,
      });
      expect((await call(owner, 'DELETE', `/attachments/${file.id}`)).status).toBe(404);

      // Another person cannot remove it, even knowing both ids.
      expect(
        (await call(stranger, 'DELETE', `/projects/${project.id}/files/${file.id}`)).status,
      ).toBe(404);

      await json(await call(owner, 'DELETE', `/projects/${project.id}/files/${file.id}`));
      expect(await usage(owner)).toEqual(before);
      expect(
        await live.db.select().from(schema.attachment).where(eq(schema.attachment.id, file.id)),
      ).toEqual([]);
      const queued = await live.db
        .select()
        .from(schema.deletedObject)
        .where(eq(schema.deletedObject.storageKey, row!.storageKey));
      expect(queued).toHaveLength(1);
      await drainDeletedObjects(new Date(Date.now() + 120_000));
      await expect(new LocalStorageDriver(storageRoot).get(row!.storageKey)).rejects.toThrow();
      expect((await call(owner, 'DELETE', `/projects/${project.id}/files/${file.id}`)).status).toBe(
        404,
      );
    });

    it('refuses a file for a project that is gone or not the uploader’s, reserving nothing', async () => {
      // The route checks ownership first; this is the check inside the upload
      // transaction that stops a project deleted mid-upload gaining a file.
      const project = await createProject(owner, 'Short-lived');
      await json(await call(owner, 'DELETE', `/projects/${project.id}`));
      const stranger = await createProject(owner, 'Someone else’s');
      const before = await usage(owner);
      const intruder = await seedUser(live.db, state.organizationId, {
        email: 'project-intruder@example.test',
      });
      for (const [userId, projectId] of [
        [owner, project.id],
        [intruder, stranger.id],
      ] as const) {
        await expect(
          uploadProjectFile({
            userId,
            role: 'user',
            projectId,
            filename: 'late.txt',
            declaredMimeType: 'text/plain',
            bytes: Buffer.from('arrived after the project went away'),
          }),
        ).rejects.toMatchObject({ status: 404 });
      }
      expect(await usage(owner)).toEqual(before);
      const [leftover] = await live.db
        .select({ pending: sql<number>`count(*)::int` })
        .from(schema.attachment)
        .where(eq(schema.attachment.filename, 'late.txt'));
      expect(leftover?.pending).toBe(0);
    });

    it('needs attachments to be allowed to upload', async () => {
      const project = await createProject(owner, 'No uploads');
      state.attachments = false;
      expect((await uploadTo(owner, project.id, 'x.txt', 'bytes')).status).toBe(422);
      state.attachments = true;
      state.roleFeatures = { roles: { user: { attachments: false } } };
      expect((await uploadTo(owner, project.id, 'x.txt', 'bytes')).status).toBe(403);
    });

    it('never treats a project file as an orphan or as trash', async () => {
      const project = await createProject(owner, 'Not orphaned');
      const uploaded = await json<{ files: ProjectFile[] }>(
        await uploadTo(owner, project.id, 'keep.txt', 'keep me'),
        201,
      );
      const [row] = await live.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, uploaded.files[0]!.id));
      const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

      await reconcileStorage({ deleteOrphans: true, now: far });
      await purgeExpiredTrash(far);
      await drainDeletedObjects(far);

      expect(
        await live.db
          .select()
          .from(schema.deletedObject)
          .where(eq(schema.deletedObject.storageKey, row!.storageKey)),
      ).toEqual([]);
      expect(
        await live.db.select().from(schema.attachment).where(eq(schema.attachment.id, row!.id)),
      ).toHaveLength(1);
      expect((await new LocalStorageDriver(storageRoot).get(row!.storageKey)).toString()).toBe(
        'keep me',
      );
    });
  });

  describe('deleting a project', () => {
    it('detaches its conversations and frees its files', async () => {
      const person = await seedUser(live.db, state.organizationId);
      const project = await createProject(person, 'Doomed', 'Be terse.');
      const first = await createThread(person, { projectId: project.id });
      const second = await createThread(person, { projectId: project.id });
      await live.db.insert(schema.message).values({
        threadId: first.id,
        userId: person,
        role: 'user',
        parts: [{ type: 'text', text: 'Keep this message' }],
      });
      const files = [];
      for (const name of ['a.txt', 'b.txt']) {
        files.push(
          (
            await json<{ files: ProjectFile[] }>(
              await uploadTo(person, project.id, name, `bytes of ${name}`),
              201,
            )
          ).files[0]!,
        );
      }
      const keys = (
        await live.db
          .select({ key: schema.attachment.storageKey })
          .from(schema.attachment)
          .where(eq(schema.attachment.projectId, project.id))
      ).map((row) => row.key);
      expect(keys).toHaveLength(2);
      expect((await usage(person)).files).toBe(2);

      const result = await json<{ detachedThreads: number; removedFiles: number }>(
        await call(person, 'DELETE', `/projects/${project.id}`),
      );
      expect(result).toMatchObject({ detachedThreads: 2, removedFiles: 2 });

      const threads = await live.db
        .select({ id: schema.thread.id, projectId: schema.thread.projectId })
        .from(schema.thread)
        .where(eq(schema.thread.userId, person));
      expect(threads).toHaveLength(2);
      expect(threads.every((thread) => thread.projectId === null)).toBe(true);
      expect(threads.map((thread) => thread.id).sort()).toEqual([first.id, second.id].sort());
      const messages = await live.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.threadId, first.id));
      expect(messages).toHaveLength(1);

      expect(await usage(person)).toEqual({ bytes: 0, files: 0 });
      expect(
        await live.db.select().from(schema.attachment).where(eq(schema.attachment.userId, person)),
      ).toEqual([]);
      const queued = await live.db
        .select({ key: schema.deletedObject.storageKey })
        .from(schema.deletedObject)
        .where(eq(schema.deletedObject.userId, person));
      expect(queued.map((row) => row.key).sort()).toEqual([...keys].sort());
      await drainDeletedObjects(new Date(Date.now() + 120_000));
      for (const key of keys) {
        await expect(new LocalStorageDriver(storageRoot).get(key)).rejects.toThrow();
      }
    });

    it('is not touched by conversation retention', async () => {
      const person = await seedUser(live.db, state.organizationId);
      const project = await createProject(person, 'Outlives its chats');
      const thread = await createThread(person, { projectId: project.id });
      await live.db
        .update(schema.thread)
        .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
        .where(eq(schema.thread.id, thread.id));
      state.retention = { threadRetentionDays: 30 };

      await applyThreadRetention();

      const [trashed] = await live.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, thread.id));
      expect(trashed?.deletedAt).not.toBeNull();
      // The trashed conversation keeps its project for a restore; the project stays.
      expect(trashed?.projectId).toBe(project.id);
      const [kept] = await live.db
        .select()
        .from(schema.project)
        .where(and(eq(schema.project.id, project.id), eq(schema.project.userId, person)));
      expect(kept?.name).toBe('Outlives its chats');
      const summary = await json<{ project: ProjectSummary }>(
        await call(person, 'GET', `/projects/${project.id}`),
      );
      expect(summary.project.threadCount).toBe(0);
    });

    it('goes with the account', async () => {
      const person = await seedUser(live.db, state.organizationId);
      const project = await createProject(person, 'Account bound');
      await json(await uploadTo(person, project.id, 'gone.txt', 'gone soon'), 201);
      await live.db.execute(sql`delete from "user" where id = ${person}`);
      expect(
        await live.db.select().from(schema.project).where(eq(schema.project.id, project.id)),
      ).toEqual([]);
    });
  });

  describe('export', () => {
    it('includes projects with instructions and files, and not other people’s', async () => {
      const person = await seedUser(live.db, state.organizationId);
      const project = await createProject(person, 'Grant / Proposal', 'Write formally.');
      const twin = await createProject(person, 'grant  proposal', '');
      const thread = await createThread(person, { projectId: project.id });
      await json(await uploadTo(person, project.id, 'budget.txt', 'Budget: 10 units'), 201);
      await json(await uploadTo(person, twin.id, 'budget.txt', 'Another budget'), 201);
      await createProject(stranger, 'Stranger project', 'secret instructions');

      const response = await appFor(person).request('/api/me/export');
      expect(response.status).toBe(200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as {
        counts: { projects: number };
        conversations: Array<{ id: string; projectId: string | null }>;
        projects: Array<{
          id: string;
          name: string;
          instructions: string;
          folder: string;
          conversations: string[];
          files: Array<{ filename: string; path: string | null }>;
        }>;
        unsentAttachments: unknown[];
      };

      expect(manifest.counts.projects).toBe(2);
      const exported = manifest.projects.find((entry) => entry.id === project.id)!;
      expect(exported).toMatchObject({
        name: 'Grant / Proposal',
        instructions: 'Write formally.',
        folder: 'projects/grant-proposal',
        conversations: [thread.id],
        files: [{ filename: 'budget.txt', path: 'projects/grant-proposal/budget.txt' }],
      });
      expect(strFromU8(files['projects/grant-proposal/budget.txt']!)).toBe('Budget: 10 units');
      const second = manifest.projects.find((entry) => entry.id === twin.id)!;
      expect(second.folder).toBe('projects/grant-proposal-2');
      expect(strFromU8(files['projects/grant-proposal-2/budget.txt']!)).toBe('Another budget');
      expect(manifest.conversations.find((entry) => entry.id === thread.id)?.projectId).toBe(
        project.id,
      );
      // Project files are not reported as unsent uploads.
      expect(manifest.unsentAttachments).toEqual([]);
      expect(JSON.stringify(manifest)).not.toContain('secret instructions');
      expect(strFromU8(files['README.txt']!)).toContain('Projects: 2');
    });
  });

  describe('Settings → Attachments (v0.9.1)', () => {
    it('lists chat and project files, and breaks storage down to the meter total', async () => {
      const person = await seedUser(live.db, state.organizationId);
      const project = await createProject(person, 'Reading list');
      await json(await uploadTo(person, project.id, 'notes.txt', 'Project notes here'), 201);
      const chat = await appFor(person).request('/api/attachments', {
        method: 'POST',
        body: form([{ name: 'chat.txt', body: 'Chat file' }]),
      });
      expect(chat.status).toBe(201);

      const listed = await json<{
        attachments: Array<{ filename: string; project: { id: string; name: string } | null }>;
      }>(await call(person, 'GET', '/attachments'));
      expect(
        listed.attachments.map((entry) => [entry.filename, entry.project?.name ?? null]).sort(),
      ).toEqual([
        ['chat.txt', null],
        ['notes.txt', 'Reading list'],
      ]);

      const usage = await json<{
        liveBytes: number;
        liveFileCount: number;
        breakdown: Record<
          'chatFiles' | 'projectFiles' | 'artifacts',
          { bytes: number; count: number }
        >;
      }>(await call(person, 'GET', '/attachments/usage'));
      expect(usage.breakdown).toEqual({
        chatFiles: { bytes: Buffer.byteLength('Chat file'), count: 1 },
        projectFiles: { bytes: Buffer.byteLength('Project notes here'), count: 1 },
        artifacts: { bytes: 0, count: 0 },
      });
      const { chatFiles, projectFiles, artifacts } = usage.breakdown;
      expect(chatFiles.bytes + projectFiles.bytes + artifacts.bytes).toBe(usage.liveBytes);
      expect(chatFiles.count + projectFiles.count).toBe(usage.liveFileCount);
    });
  });
});
