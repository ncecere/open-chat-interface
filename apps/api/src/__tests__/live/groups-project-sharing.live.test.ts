import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { sharingHelpers } from '../../../test/project-sharing.fixtures.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * The groups code and the project-sharing code were built apart. These tests use the real group functions
 * (not raw SQL) to remove a member and delete a group, and check that the project-sharing consequences happen
 * in the same transaction: conversations leave the project and files go to the owner at once, without the
 * one-minute job (the other lifecycle tests prove the job's side). Real PostgreSQL.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  role: 'user',
  driver: null as unknown,
  roleFeatures: {} as Record<string, unknown>,
  replicas: [] as Array<{ version: string }> | null,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async () => ({
    slug: 'test-model',
    capabilities: [],
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: undefined,
    maxOutputTokens: undefined,
    languageModel: {},
  }),
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/limits/rate-limit.js', () => {
  const allowed = async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 1 });
  return { consumeRateLimit: allowed, uploadRateLimit: allowed, threadCreateRateLimit: allowed };
});
vi.mock('../../services/jobs/workers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/jobs/workers.js')>()),
  liveReplicas: async () => state.replicas,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'storage') {
      return {
        driver: 'local',
        maxFileBytes: 10 * 1024 * 1024,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain', 'text/markdown'],
      };
    }
    if (key === 'features') return { attachments: true, temporaryChat: true };
    if (key === 'roleFeatures') return state.roleFeatures;
    return {};
  },
  invalidateSettingsCache: () => {},
}));
vi.mock('../../services/storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => 'INSTANCE' }));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/quota/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/quota/index.js')>()),
  reserveQuotaForRun: async () => null,
  releaseReservation: async () => {},
  settleReservation: async () => {},
  recordUsage: async () => {},
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  beginChatRun: async () => 'unavailable',
  abandonChatRun: async () => {},
  unregisterLocalChatRun: () => {},
}));

const { projectRoutes } = await import('../../routes/projects.js');
const { threadRoutes } = await import('../../routes/threads.js');
const { attachmentRoutes } = await import('../../routes/attachments.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { removeGroupMember } = await import('../../services/groups/membership.js');
const { deleteGroup } = await import('../../services/groups/groups.js');
const { countGroupSharedProjects } = await import('../../services/groups/access-changes.js');

describe.skipIf(!available)('live: groups and project sharing together', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  const runs = new Set<AcquiredRun>();

  const h = sharingHelpers({
    state,
    routes: { projectRoutes, threadRoutes, attachmentRoutes },
    errorHandler,
    db: () => pool.db,
  });

  beforeAll(async () => {
    live = await createLiveDatabase('project_sharing_lifecycle');
    pool = createDatabase(live.connectionString, { max: 10 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    root = await mkdtemp(join(tmpdir(), 'oci-sharing-'));
    state.driver = new LocalStorageDriver(root);
  });
  afterEach(async () => {
    state.role = 'user';
    state.roleFeatures = {};
    state.replicas = [];
    const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
    for (const run of runs) await releaseRunHandles(run, true);
    runs.clear();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const admin = {
    id: 'admin-id',
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin' as const,
  };

  it('removing a member through the groups code reconciles their projects at once', async () => {
    const owner = await h.person('Owner');
    const member = await h.person('Member');
    const group = await h.makeGroup('Dept', [owner, member]);
    const project = await h.createProject(owner, 'Dept project');
    await h.shareWithGroup(owner, project.id, group, 'editor');
    const file = await h.seedFile(member, project.id, 'member.txt', 'MEMBER-CANARY');
    const chat = await h.thread(member, project.id);

    await removeGroupMember({ actor: admin, groupId: group, userId: member.id });

    // No job ran: the invariants already hold.
    expect(await h.threadProject(chat.id)).toBeNull();
    expect((await h.filesOf(project.id)).map((f) => ({ id: f.id, owner: f.userId }))).toEqual([
      { id: file.id, owner: owner.id },
    ]);
    const storage = await h.storage(owner);
    expect(storage.counterBytes).toBe(storage.rowBytes);
    expect((await h.call(member, 'GET', `/projects/${project.id}`)).status).toBe(404);
    const [revoked] = await h.auditOf('project.access.revoked', project.id);
    expect(revoked).toBeDefined();
  });

  it('a member who still reaches the project another way keeps everything', async () => {
    const owner = await h.person('Owner');
    const member = await h.person('Member');
    const group = await h.makeGroup('Two paths', [owner, member]);
    const project = await h.createProject(owner, 'Two paths project');
    await h.shareWith(owner, project.id, member, 'editor');
    await h.shareWithGroup(owner, project.id, group, 'editor');
    const file = await h.seedFile(member, project.id, 'mine.txt', 'x');
    const chat = await h.thread(member, project.id);

    await removeGroupMember({ actor: admin, groupId: group, userId: member.id });

    expect(await h.threadProject(chat.id)).toBe(project.id);
    expect((await h.filesOf(project.id))[0]).toMatchObject({ id: file.id, userId: member.id });
  });

  it('deleting a group counts its projects, then reconciles them against the access that remains', async () => {
    const owner = await h.person('Owner');
    const member = await h.person('Member');
    const stays = await h.person('Stays');
    const group = await h.makeGroup('Doomed', [owner, member, stays]);
    const a = await h.createProject(owner, 'Project A');
    const b = await h.createProject(owner, 'Project B');
    await h.shareWithGroup(owner, a.id, group, 'editor');
    await h.shareWithGroup(owner, b.id, group, 'viewer');
    await h.shareWith(owner, a.id, stays, 'viewer');
    const file = await h.seedFile(member, a.id, 'member.txt', 'x');
    const chatA = await h.thread(member, a.id);
    const chatB = await h.thread(member, b.id);
    const chatStays = await h.thread(stays, a.id);
    expect(await countGroupSharedProjects(pool.db, group)).toBe(2);

    const result = await deleteGroup(admin, group);

    expect(result.removed.sharedProjects).toBe(2);
    expect(await countGroupSharedProjects(pool.db, group)).toBe(0);
    // The member lost both projects: conversations leave, their file goes to the owner.
    expect(await h.threadProject(chatA.id)).toBeNull();
    expect(await h.threadProject(chatB.id)).toBeNull();
    expect((await h.filesOf(a.id))[0]).toMatchObject({ id: file.id, userId: owner.id });
    // A person with a direct share on A keeps A.
    expect(await h.threadProject(chatStays.id)).toBe(a.id);
    expect((await h.call(stays, 'GET', `/projects/${a.id}`)).status).toBe(200);
  });
});
