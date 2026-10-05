import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectSummary } from '@oci/shared';
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
 * This suite covers creating, reading, updating and deleting projects, the limits and
 * the role switch; the shared helpers live in
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

const { eq, schema } = await import('@oci/db');
const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: projects', () => {
  let live: LiveDatabase;
  let owner: string;
  let stranger: string;

  const { call, createProject, createThread, json, uploadTo, usage } = projectsHelpers({
    state,
    routes: { projectRoutes, threadRoutes, attachmentRoutes, portabilityRoutes },
    errorHandler,
    db: () => live.db,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('projects_crud');
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
});
