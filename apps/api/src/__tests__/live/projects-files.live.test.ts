import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectFile } from '@oci/shared';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { projectsHelpers } from '../../../test/projects.fixtures.js';

/**
 * Projects through the real routes, real PostgreSQL (including migration 0024's
 * constraints and the attachment delete triggers) and real local storage.
 * Settings, the organisation and rate limiting are the only stubs.
 * This suite covers project files, the export and Settings → Attachments; the shared helpers live in
 * test/projects.fixtures.ts.
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

const { eq, schema, sql } = await import('@oci/db');
const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
const { drainDeletedObjects, reconcileStorage } = await import('../../services/storage/reaper.js');
const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
const { uploadProjectFile } = await import('../../services/projects.js');

describe.skipIf(!available)('live: projects', () => {
  let live: LiveDatabase;
  let owner: string;
  let stranger: string;

  const { appFor, call, createProject, createThread, form, json, uploadTo, usage } =
    projectsHelpers({
      state,
      routes: { projectRoutes, threadRoutes, attachmentRoutes, portabilityRoutes },
      errorHandler,
      db: () => live.db,
    });

  beforeAll(async () => {
    live = await createLiveDatabase('projects_files');
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
