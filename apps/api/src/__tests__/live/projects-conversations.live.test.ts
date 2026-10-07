import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectFile, ProjectSummary, ThreadSummary } from '@oci/shared';
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
 * This suite covers conversations in a project and deleting a project; the shared helpers live in
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

const { and, eq, schema, sql } = await import('@oci/db');
const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { LocalStorageDriver } = await import('../../services/storage/local-driver.js');
const { drainDeletedObjects } = await import('../../services/storage/reaper.js');
const { applyThreadRetention } = await import('../../services/lifecycle/retention.js');

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
    live = await createLiveDatabase('projects_conversations');
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
});
