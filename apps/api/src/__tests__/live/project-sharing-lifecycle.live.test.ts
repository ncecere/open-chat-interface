import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelText } from '../../../test/chat-project-search.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { type Person, sharingHelpers } from '../../../test/project-sharing.fixtures.js';
import type { AppBindings } from '../../middleware/context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * What happens when access to a project ends (v0.14, project sharing): a share
 * removed or downgraded, a member removed, a group deleted, a transfer, the
 * `projects` switch turned off, an account deleted, a legal hold. Real
 * PostgreSQL, the real routes, the real turn preparation and the real
 * projects.reconcile-access job. Invariants checked (SPEC-groups.md):
 * I-1 every finished project file belongs to the owner or a current editor;
 * I-2 a person's conversation points at a project only if they can read it;
 * I-3 nothing about shares or membership is cached across requests.
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
const { userRoutes } = await import('../../routes/admin/users.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { reconcileAccessLeftovers } = await import('../../services/project-sharing/reconcile.js');
const { lifecycleJobs } = await import('../../services/jobs/index.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { accountSharingImpact } = await import('../../services/project-sharing/impact.js');

describe.skipIf(!available)('live: project sharing lifecycle', () => {
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

  /** A turn in the person's own conversation in the project: what the model is given. */
  async function turn(who: Person, projectId: string, text = 'Summarise the notes.') {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const own = await h.thread(who, projectId);
    const started = await setupTurn(
      { id: who.id, name: who.name, role: 'user' },
      {
        threadId: own.id,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
      },
    );
    runs.add(started.run);
    return { started, text: await modelText(started), system: started.turn.system };
  }

  /** A project with an owner, an editor and a viewer, a file from each of the first two, and a conversation each. */
  async function world() {
    const owner = await h.person('Owner');
    const editor = await h.person('Editor');
    const viewer = await h.person('Viewer');
    const project = await h.createProject(owner, 'Plan', 'Follow the PLAN-RULE always.');
    const editorShare = await h.shareWith(owner, project.id, editor, 'editor');
    const viewerShare = await h.shareWith(owner, project.id, viewer, 'viewer');
    const ownerFile = await h.seedFile(owner, project.id, 'owner.txt', 'OWNER-CANARY notes');
    const editorFile = await h.seedFile(editor, project.id, 'editor.txt', 'EDITOR-CANARY notes');
    await indexProjectFile(ownerFile.id);
    await indexProjectFile(editorFile.id);
    const threads = {
      owner: await h.thread(owner, project.id),
      editor: await h.thread(editor, project.id),
      viewer: await h.thread(viewer, project.id),
    };
    return {
      owner,
      editor,
      viewer,
      project,
      editorShare,
      viewerShare,
      ownerFile,
      editorFile,
      threads,
    };
  }

  async function messageCount(threadId: string) {
    const [row] = await pool.db.execute<{ n: number }>(
      sql`select count(*)::int as n from message where thread_id = ${threadId}`,
    );
    return row!.n;
  }

  describe('a share is removed', () => {
    it('ends access at once, detaches the conversations, keeps everything they said, and the next turn has no context', async () => {
      const w = await world();
      // Before: the viewer's turn carries the instructions and the files.
      const before = await turn(w.viewer, w.project.id);
      expect(before.system).toContain('PLAN-RULE');
      expect(before.text).toContain('EDITOR-CANARY');
      const ownThread = w.threads.viewer;
      // Give the viewer's conversation a message so there is something not to recall.
      await pool.db.insert(schema.message).values({
        threadId: ownThread.id,
        userId: w.viewer.id,
        role: 'user',
        parts: [{ type: 'text', text: 'what the viewer already saw' }],
        position: 0,
      });

      const removed = await h.ok(
        w.owner,
        'DELETE',
        `/projects/${w.project.id}/shares/${w.viewerShare.id}`,
      );
      expect(removed).toMatchObject({ ok: true });
      // The same request: the viewer's conversations (this and the turn's own) left the project.
      expect(removed.detachedThreads).toBeGreaterThanOrEqual(1);

      // Next requests: nothing of the project.
      for (const path of [
        `/projects/${w.project.id}`,
        `/projects/${w.project.id}/files`,
        `/projects/${w.project.id}/access`,
      ]) {
        expect((await h.call(w.viewer, 'GET', path)).status, path).toBe(404);
      }
      expect(
        (await h.call(w.viewer, 'GET', `/attachments/${w.editorFile.id}/content`)).status,
      ).toBe(404);
      const list = await h.ok(w.viewer, 'GET', '/projects');
      expect([...list.projects, ...list.shared]).toEqual([]);
      const sidebar = await h.ok(w.viewer, 'GET', '/projects/sidebar');
      expect([...sidebar.projects, ...sidebar.shared]).toEqual([]);

      // The conversation left the project; it and its message are still the viewer's.
      expect(await h.threadProject(ownThread.id)).toBeNull();
      expect(await messageCount(ownThread.id)).toBe(1);
      const stillThere = await h.call(w.viewer, 'GET', `/threads/${ownThread.id}`);
      expect(stillThere.status).toBe(200);
      // And the project's other people are untouched.
      expect(await h.threadProject(w.threads.owner.id)).toBe(w.project.id);
      expect(await h.threadProject(w.threads.editor.id)).toBe(w.project.id);

      // A turn in a conversation that used to be in the project carries no instructions or passages.
      const after = await turn(w.viewer, w.project.id);
      expect(after.system).not.toContain('PLAN-RULE');
      expect(after.text).not.toContain('CANARY');
    });

    it('hands an editor’s files to the owner, with both counters right, and keeps nothing the owner did not have access to', async () => {
      const w = await world();
      const before = { owner: await h.storage(w.owner), editor: await h.storage(w.editor) };
      const size = w.editorFile.sizeBytes;
      const removed = await h.ok(
        w.owner,
        'DELETE',
        `/projects/${w.project.id}/shares/${w.editorShare.id}`,
      );
      expect(removed.movedFiles).toBe(1);

      const files = await h.filesOf(w.project.id);
      expect(files.map((file) => [file.filename, file.userId])).toEqual([
        ['editor.txt', w.owner.id],
        ['owner.txt', w.owner.id],
      ]);
      const after = { owner: await h.storage(w.owner), editor: await h.storage(w.editor) };
      expect(after.owner.counterBytes).toBe(before.owner.counterBytes + size);
      expect(after.owner.counterFiles).toBe(before.owner.counterFiles + 1);
      expect(after.editor.counterBytes).toBe(before.editor.counterBytes - size);
      // Counters are the totals of the rows, for everyone.
      for (const side of Object.values(after)) {
        expect(side.counterBytes).toBe(side.rowBytes);
        expect(side.counterFiles).toBe(side.rowFiles);
      }
      // The ex-editor can neither read nor remove what they added, and the owner can.
      expect(
        (await h.call(w.editor, 'GET', `/attachments/${w.editorFile.id}/content`)).status,
      ).toBe(404);
      expect(
        (await h.call(w.editor, 'DELETE', `/projects/${w.project.id}/files/${w.editorFile.id}`))
          .status,
      ).toBe(404);
      const listed = await h.ok(w.owner, 'GET', `/projects/${w.project.id}/files`);
      expect(listed.files.map((file: { id: string }) => file.id)).toContain(w.editorFile.id);
    });

    it('is not blocked by a full allowance: the move never refuses for lack of room', async () => {
      const w = await world();
      await pool.db.execute(
        sql`update storage_usage set live_bytes = 999999999999 where user_id = ${w.owner.id}`,
      );
      const removed = await h.ok(
        w.owner,
        'DELETE',
        `/projects/${w.project.id}/shares/${w.editorShare.id}`,
      );
      expect(removed.movedFiles).toBe(1);
    });

    it('writes one system entry with counts and no names', async () => {
      const w = await world();
      await h.ok(w.owner, 'DELETE', `/projects/${w.project.id}/shares/${w.editorShare.id}`);
      const [revoked] = await h.auditOf('project.access.revoked', w.project.id);
      expect(revoked?.metadata).toMatchObject({
        cause: 'share',
        movedFiles: 1,
        detachedConversations: 1,
      });
      expect(JSON.stringify(revoked)).not.toContain('Plan');
      const [deleted] = await h.auditOf('project.share.delete', w.project.id);
      expect(deleted).toMatchObject({
        actorUserId: w.owner.id,
        targetType: 'project',
        targetId: w.project.id,
      });
      expect(deleted!.metadata).toMatchObject({
        subjectType: 'person',
        subjectUserId: w.editor.id,
        permission: 'editor',
      });
      expect(JSON.stringify(deleted)).not.toContain('Plan');
    });
  });

  describe('a share is downgraded', () => {
    it('ends editing at once: the files go to the owner, the person stays a viewer and keeps their conversations', async () => {
      const w = await world();
      const changed = await h.ok(
        w.owner,
        'PATCH',
        `/projects/${w.project.id}/shares/${w.editorShare.id}`,
        { permission: 'viewer' },
      );
      expect(changed.share.permission).toBe('viewer');
      expect((await h.filesOf(w.project.id)).every((file) => file.userId === w.owner.id)).toBe(
        true,
      );
      expect((await h.upload(w.editor, w.project.id, 'late.txt', 'x')).status).toBe(403);
      expect((await h.call(w.editor, 'GET', `/projects/${w.project.id}`)).json.project.access).toBe(
        'viewer',
      );
      expect(await h.threadProject(w.threads.editor.id)).toBe(w.project.id);
      const [update] = await h.auditOf('project.share.update', w.project.id);
      expect(update?.metadata).toMatchObject({
        permission: 'viewer',
        previousPermission: 'editor',
      });
    });

    it('an upgrade moves nothing and changing to the same permission changes nothing', async () => {
      const w = await world();
      await h.ok(w.owner, 'PATCH', `/projects/${w.project.id}/shares/${w.viewerShare.id}`, {
        permission: 'editor',
      });
      await h.ok(w.owner, 'PATCH', `/projects/${w.project.id}/shares/${w.viewerShare.id}`, {
        permission: 'editor',
      });
      expect((await h.filesOf(w.project.id)).map((file) => file.userId).sort()).toEqual(
        [w.editor.id, w.owner.id].sort(),
      );
      expect(await h.auditOf('project.share.update', w.project.id)).toHaveLength(1);
    });
  });

  describe('a person leaves', () => {
    it('removes their own direct share; the owner and a group-only member cannot', async () => {
      const w = await world();
      const left = await h.ok(w.editor, 'POST', `/projects/${w.project.id}/leave`);
      expect(left).toMatchObject({ ok: true, movedFiles: 1 });
      expect((await h.call(w.editor, 'GET', `/projects/${w.project.id}`)).status).toBe(404);
      expect(await h.threadProject(w.threads.editor.id)).toBeNull();
      expect((await h.call(w.owner, 'POST', `/projects/${w.project.id}/leave`)).status).toBe(409);
      const member = await h.person('Member');
      const group = await h.makeGroup('Leavers', [w.owner, member]);
      await h.shareWithGroup(w.owner, w.project.id, group, 'viewer');
      const refused = await h.call(member, 'POST', `/projects/${w.project.id}/leave`);
      expect(refused.status).toBe(409);
      expect(refused.json.error.details).toEqual({ reason: 'leave_via_group' });
      expect((await h.call(member, 'GET', `/projects/${w.project.id}`)).status).toBe(200);
      const [entry] = await h.auditOf('project.share.delete', w.project.id);
      expect(entry?.metadata).toMatchObject({ left: true, subjectUserId: w.editor.id });
    });
  });

  describe('group membership ends', () => {
    it('refuses at the next request without any job, then the job detaches conversations and moves files', async () => {
      const owner = await h.person('Owner');
      const member = await h.person('Member');
      const group = await h.makeGroup('Dept', [owner, member]);
      const project = await h.createProject(owner, 'Dept project', 'Use DEPT-RULE.');
      await h.shareWithGroup(owner, project.id, group, 'editor');
      const file = await h.seedFile(member, project.id, 'member.txt', 'MEMBER-CANARY');
      const chat = await h.thread(member, project.id);
      expect((await turn(member, project.id)).system).toContain('DEPT-RULE');

      // Membership removed by code that does not reconcile (the groups module's, or a manual delete).
      await pool.db.execute(
        sql`delete from group_member where group_id = ${group} and user_id = ${member.id}`,
      );

      // I-3: no job has run, and the very next request already refuses.
      expect((await h.call(member, 'GET', `/projects/${project.id}`)).status).toBe(404);
      expect((await h.call(member, 'GET', `/attachments/${file.id}/content`)).status).toBe(404);
      expect((await h.upload(member, project.id, 'again.txt', 'x')).status).toBe(404);
      const after = await turn(member, project.id);
      expect(after.system).not.toContain('DEPT-RULE');
      expect(after.text).not.toContain('MEMBER-CANARY');
      // Leftovers, until the job runs: I-1 and I-2 are what the job restores.
      expect(await h.threadProject(chat.id)).toBe(project.id);
      expect((await h.filesOf(project.id))[0]?.userId).toBe(member.id);

      expect(await reconcileAccessLeftovers(pool.db)).toBeGreaterThanOrEqual(1);
      expect(await h.threadProject(chat.id)).toBeNull();
      expect((await h.filesOf(project.id)).map((f) => f.userId)).toEqual([owner.id]);
      const storage = await h.storage(owner);
      expect(storage.counterBytes).toBe(storage.rowBytes);
      const [revoked] = await h.auditOf('project.access.revoked', project.id);
      expect(revoked?.metadata).toMatchObject({ cause: 'job' });
    });

    it('a deleted group cascades its shares, so its members lose access at once', async () => {
      const owner = await h.person('Owner');
      const member = await h.person('Member');
      const group = await h.makeGroup('Doomed', [owner, member]);
      const project = await h.createProject(owner, 'Group project');
      await h.shareWithGroup(owner, project.id, group, 'viewer');
      expect((await h.call(member, 'GET', `/projects/${project.id}`)).status).toBe(200);
      await pool.db.execute(sql`delete from "group" where id = ${group}`);
      expect((await h.call(member, 'GET', `/projects/${project.id}`)).status).toBe(404);
      expect(await h.call(owner, 'GET', `/projects/${project.id}/shares`)).toMatchObject({
        json: { shares: [] },
      });
    });

    it('keeps a person with another path to the project: the highest access that remains wins', async () => {
      const owner = await h.person('Owner');
      const member = await h.person('Member');
      const group = await h.makeGroup('Two paths', [owner, member]);
      const project = await h.createProject(owner, 'Two paths project');
      const direct = await h.shareWith(owner, project.id, member, 'viewer');
      await h.shareWithGroup(owner, project.id, group, 'editor');
      expect((await h.call(member, 'GET', `/projects/${project.id}`)).json.project.access).toBe(
        'editor',
      );
      const file = await h.seedFile(member, project.id, 'both.txt', 'x');
      // Dropping the direct share leaves the group's editor access: nothing moves.
      const removed = await h.ok(owner, 'DELETE', `/projects/${project.id}/shares/${direct.id}`);
      expect(removed.movedFiles).toBe(0);
      expect((await h.filesOf(project.id))[0]).toMatchObject({ id: file.id, userId: member.id });
    });
  });

  describe('unfinished uploads', () => {
    it('stay with their uploader until they complete, then the job moves them', async () => {
      const w = await world();
      const pending = await h.seedFile(w.editor, w.project.id, 'half.txt', 'HALF', {
        pending: true,
      });
      await h.ok(w.owner, 'DELETE', `/projects/${w.project.id}/shares/${w.editorShare.id}`);
      expect((await h.filesOf(w.project.id)).find((file) => file.id === pending.id)?.userId).toBe(
        w.editor.id,
      );
      // The upload completes after access ended: finished, by someone who is no editor.
      await pool.db.execute(
        sql`update attachment set upload_pending = false where id = ${pending.id}`,
      );
      expect(await reconcileAccessLeftovers(pool.db)).toBe(1);
      expect((await h.filesOf(w.project.id)).find((file) => file.id === pending.id)?.userId).toBe(
        w.owner.id,
      );
      expect(await reconcileAccessLeftovers(pool.db)).toBe(0);
    });
  });

  describe('transfer', () => {
    it('makes the direct editor the owner and the old owner a direct editor, without moving a file or a counter', async () => {
      const w = await world();
      const before = { owner: await h.storage(w.owner), editor: await h.storage(w.editor) };
      const moved = await h.ok(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
        email: w.editor.email,
      });
      expect(moved.project).toMatchObject({
        id: w.project.id,
        access: 'editor',
        ownerName: w.editor.name,
      });
      expect((await h.call(w.editor, 'GET', `/projects/${w.project.id}`)).json.project.access).toBe(
        'owner',
      );
      expect((await h.call(w.owner, 'DELETE', `/projects/${w.project.id}`)).status).toBe(403);
      expect(
        (
          await h.call(w.owner, 'POST', `/projects/${w.project.id}/shares`, {
            subject: { type: 'person', email: 'x@example.com' },
            permission: 'viewer',
          })
        ).status,
      ).toBe(403);
      // The viewer stays a viewer; the conversations are all still in the project.
      expect((await h.call(w.viewer, 'GET', `/projects/${w.project.id}`)).json.project.access).toBe(
        'viewer',
      );
      for (const chat of Object.values(w.threads))
        expect(await h.threadProject(chat.id)).toBe(w.project.id);
      expect(await h.storage(w.owner)).toEqual(before.owner);
      expect(await h.storage(w.editor)).toEqual(before.editor);
      // The old owner's own file is still readable and removable as an editor.
      expect(
        (await h.call(w.owner, 'DELETE', `/projects/${w.project.id}/files/${w.ownerFile.id}`))
          .status,
      ).toBe(200);
      const [entry] = await h.auditOf('project.transfer', w.project.id);
      expect(entry?.metadata).toMatchObject({ fromUserId: w.owner.id, toUserId: w.editor.id });
      expect(JSON.stringify(entry)).not.toContain('Plan');
    });

    it('refuses a target that is not a direct editor, even a group editor or a viewer', async () => {
      const w = await world();
      const reasons: Array<[Person, string]> = [[w.viewer, 'transfer_target_not_editor']];
      const stranger = await h.person('Stranger');
      reasons.push([stranger, 'transfer_target_not_editor']);
      const member = await h.person('GroupEditor');
      const group = await h.makeGroup('Editors', [w.owner, member]);
      await h.shareWithGroup(w.owner, w.project.id, group, 'editor');
      reasons.push([member, 'transfer_target_not_editor']);
      for (const [who, reason] of reasons) {
        const refused = await h.call(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
          email: who.email,
        });
        expect(refused.status, who.email).toBe(422);
        expect(refused.json.error.details).toEqual({ reason });
      }
      const unknown = await h.call(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
        email: 'nobody@example.com',
      });
      expect(unknown.json.error.details).toEqual({ reason: 'person_not_found' });
      const self = await h.call(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
        email: w.owner.email,
      });
      expect(self.json.error.details).toEqual({ reason: 'cannot_share_with_self' });
    });

    it('refuses when the new owner has 100 projects or projects are off for their role', async () => {
      const w = await world();
      await pool.db.execute(sql`
        insert into project (organization_id, user_id, name)
        select ${state.organizationId}, ${w.editor.id}, 'Filler ' || g from generate_series(1, 100) g`);
      const full = await h.call(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
        email: w.editor.email,
      });
      expect(full.status).toBe(422);
      expect(full.json.error.details).toEqual({ reason: 'transfer_target_project_limit' });
      expect(full.json.error.message).toContain('100');
      await pool.db.execute(
        sql`delete from project where name like 'Filler %' and user_id = ${w.editor.id}`,
      );
      await pool.db.execute(sql`update "user" set role = 'restricted' where id = ${w.editor.id}`);
      const off = await h.call(w.owner, 'POST', `/projects/${w.project.id}/transfer`, {
        email: w.editor.email,
      });
      expect(off.json.error.details).toEqual({ reason: 'transfer_target_projects_off' });
    });
  });

  describe('the projects switch', () => {
    it('hides shared projects from a role that has it off, and its turns carry no context', async () => {
      const w = await world();
      state.roleFeatures = { roles: { user: { projects: false } } };
      for (const path of [
        `/projects/${w.project.id}`,
        '/projects',
        '/projects/sidebar',
        `/projects/${w.project.id}/files`,
      ]) {
        expect((await h.call(w.viewer, 'GET', path)).status, path).toBe(403);
      }
      expect(
        (await h.call(w.viewer, 'GET', `/attachments/${w.editorFile.id}/content`)).status,
      ).toBe(403);
      const quiet = await turn(w.viewer, w.project.id);
      expect(quiet.system).not.toContain('PLAN-RULE');
      expect(quiet.text).not.toContain('CANARY');
    });
  });

  describe('loading the files of a turn', () => {
    it('refuses project files the person can no longer read, even when the candidates were chosen a moment earlier', async () => {
      const w = await world();
      const { inspectProjectFiles, materializeAttachments } = await import(
        '../../services/chat/attachment-context.js'
      );
      const candidates = await inspectProjectFiles(w.project.id, w.viewer.id);
      expect(candidates.length).toBe(2);
      const loaded = await materializeAttachments([], w.viewer.id, 'user', false, {
        id: w.project.id,
        files: candidates,
      });
      expect([...loaded.keys()].sort()).toEqual(candidates.map((file) => file.id).sort());
      // Access ends between choosing the files and reading them.
      await h.ok(w.owner, 'DELETE', `/projects/${w.project.id}/shares/${w.viewerShare.id}`);
      await expect(
        materializeAttachments([], w.viewer.id, 'user', false, {
          id: w.project.id,
          files: candidates,
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('Attachment context changed') });
      // A project file passed off as one of the person's own message files is refused too.
      await expect(
        materializeAttachments(candidates, w.viewer.id, 'user', false),
      ).rejects.toMatchObject({ message: expect.stringContaining('Attachment context changed') });
    });
  });

  describe('a reply already streaming', () => {
    it('finishes with the context it began with when access ends under it', async () => {
      const w = await world();
      const started = await turn(w.viewer, w.project.id);
      await h.ok(w.owner, 'DELETE', `/projects/${w.project.id}/shares/${w.viewerShare.id}`);
      // The turn was assembled before the revocation and is not recomputed.
      expect(started.system).toContain('PLAN-RULE');
      expect(started.text).toContain('EDITOR-CANARY');
      expect(started.started.turn.uiMessages.length).toBeGreaterThan(0);
    });
  });

  describe('concurrency', () => {
    it('two reconciles at once do the work once and leave the counters equal to the rows', async () => {
      const owner = await h.person('Owner');
      const gone = await h.person('Gone');
      const project = await h.createProject(owner, 'Races');
      await h.shareWith(owner, project.id, gone, 'editor');
      for (let i = 0; i < 5; i += 1) await h.seedFile(gone, project.id, `f${i}.txt`, `File ${i}`);
      await pool.db.execute(sql`delete from project_share where project_id = ${project.id}`);
      const results = await Promise.all([
        reconcileAccessLeftovers(pool.db),
        reconcileAccessLeftovers(pool.db),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
      expect((await h.filesOf(project.id)).map((file) => file.userId)).toEqual(
        Array(5).fill(owner.id),
      );
      for (const who of [owner, gone]) {
        const s = await h.storage(who);
        expect(s.counterBytes, who.name).toBe(s.rowBytes);
        expect(s.counterFiles, who.name).toBe(s.rowFiles);
      }
      expect((await h.storage(owner)).rowFiles).toBe(5);
      expect(await reconcileAccessLeftovers(pool.db)).toBe(0);
    });

    it('an upload racing the removal of its share either fails or ends with the owner holding the file', async () => {
      for (let round = 0; round < 6; round += 1) {
        const owner = await h.person('Owner');
        const editor = await h.person('Editor');
        const project = await h.createProject(owner, `Race ${round}`);
        const share = await h.shareWith(owner, project.id, editor, 'editor');
        const [uploaded, removed] = await Promise.all([
          h.upload(editor, project.id, 'racing.txt', `Racing ${round}`),
          h.call(owner, 'DELETE', `/projects/${project.id}/shares/${share.id}`),
        ]);
        expect(removed.status).toBe(200);
        expect([201, 404]).toContain(uploaded.status);
        await reconcileAccessLeftovers(pool.db);
        const files = await h.filesOf(project.id);
        // I-1 after the job: nobody but the owner holds a file of this project.
        expect(files.every((file) => file.userId === owner.id)).toBe(true);
        if (uploaded.status === 201) expect(files).toHaveLength(1);
        for (const who of [owner, editor]) {
          const s = await h.storage(who);
          expect(s.counterBytes).toBe(s.rowBytes);
        }
      }
    });

    it('deleting a project while an editor uploads leaves no orphan and no counter drift', async () => {
      for (let round = 0; round < 4; round += 1) {
        const owner = await h.person('Owner');
        const editor = await h.person('Editor');
        const project = await h.createProject(owner, `Doomed ${round}`);
        await h.shareWith(owner, project.id, editor, 'editor');
        const [uploaded, deleted] = await Promise.all([
          h.upload(editor, project.id, 'late.txt', 'Late file'),
          h.call(owner, 'DELETE', `/projects/${project.id}`),
        ]);
        expect(deleted.status).toBe(200);
        expect([201, 404]).toContain(uploaded.status);
        expect(await h.filesOf(project.id)).toEqual([]);
        for (const who of [owner, editor]) {
          const s = await h.storage(who);
          expect(s.counterBytes).toBe(s.rowBytes);
          expect(s.counterFiles).toBe(s.rowFiles);
        }
      }
    });
  });

  describe('deleting accounts', () => {
    function adminApp(admin: Person) {
      const app = new Hono<AppBindings>();
      app.onError(errorHandler);
      app.use('*', async (c, next) => {
        c.set('user', {
          id: admin.id,
          role: 'admin',
          name: admin.name,
          email: admin.email,
          image: null,
          emailVerified: true,
          organizationId: state.organizationId,
        });
        await next();
      });
      app.use('*', requireAdmin);
      app.route('/users', userRoutes);
      return app;
    }
    const removeAccount = (admin: Person, id: string) =>
      adminApp(admin).request(`/users/${id}`, { method: 'DELETE' });

    it('deleting an editor hands the files they added to the owners instead of deleting another person’s content', async () => {
      const admin = await h.person('Admin', 'admin');
      const w = await world();
      const sizeBefore = (await h.storage(w.owner)).counterBytes;
      const response = await removeAccount(admin, w.editor.id);
      expect(response.status).toBe(200);
      const files = await h.filesOf(w.project.id);
      expect(files.map((file) => [file.filename, file.userId])).toEqual([
        ['editor.txt', w.owner.id],
        ['owner.txt', w.owner.id],
      ]);
      const owner = await h.storage(w.owner);
      expect(owner.counterBytes).toBe(sizeBefore + w.editorFile.sizeBytes);
      expect(owner.counterBytes).toBe(owner.rowBytes);
      const listed = await h.ok(w.owner, 'GET', `/projects/${w.project.id}/files`);
      expect(listed.files.map((file: { id: string }) => file.id)).toContain(w.editorFile.id);
      // The editor's conversations went with the account; the others are untouched.
      expect(await h.threadProject(w.threads.viewer.id)).toBe(w.project.id);
      const [entry] = await h.auditOf('user.delete', w.editor.id);
      expect(entry?.metadata).toMatchObject({ deletion: { filesHandedToOwners: 1 } });
    });

    it('deleting an owner removes the project, its shares and every file, detaches other people’s conversations, and says how many', async () => {
      const admin = await h.person('Admin', 'admin');
      const w = await world();
      // The dialogs say what is about to happen to other people.
      expect(await accountSharingImpact(w.owner.id)).toEqual({
        sharedProjects: 1,
        otherConversations: 2,
        othersFiles: 1,
        filesHandedToOwners: 0,
      });
      expect(await accountSharingImpact(w.editor.id)).toEqual({
        sharedProjects: 0,
        otherConversations: 0,
        othersFiles: 0,
        filesHandedToOwners: 1,
      });
      expect((await removeAccount(admin, w.owner.id)).status).toBe(200);
      expect(await h.filesOf(w.project.id)).toEqual([]);
      const shares = await pool.db.execute(
        sql`select 1 from project_share where project_id = ${w.project.id}`,
      );
      expect(shares).toHaveLength(0);
      for (const who of ['editor', 'viewer'] as const)
        expect(await h.threadProject(w.threads[who].id)).toBeNull();
      // Their conversations are kept.
      expect(await messageCount(w.threads.viewer.id)).toBe(0);
      const rows = await pool.db
        .select()
        .from(schema.thread)
        .where(eq(schema.thread.id, w.threads.viewer.id));
      expect(rows).toHaveLength(1);
      const [entry] = await h.auditOf('user.delete', w.owner.id);
      expect(entry?.metadata).toMatchObject({
        deletion: { projects: 1, sharedProjects: 1, otherConversationsInProjects: 2 },
      });
      // The editor's counters followed the deletion of their files (the owner's project took them).
      const editor = await h.storage(w.editor);
      expect(editor.counterBytes).toBe(editor.rowBytes);
    });

    it('refuses to delete an owner while a person on hold has files in their project, and an editor who is on hold', async () => {
      const admin = await h.person('Admin', 'admin');
      const w = await world();
      await h.hold(w.editor);
      const refused = await removeAccount(admin, w.owner.id);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
        'legal hold',
      );
      // The project and the editor's file are intact.
      expect((await h.filesOf(w.project.id)).map((file) => file.filename)).toEqual([
        'editor.txt',
        'owner.txt',
      ]);
      // The held editor's own account is refused as ever.
      expect((await removeAccount(admin, w.editor.id)).status).toBe(409);
      await h.lift(w.editor);
      expect((await removeAccount(admin, w.owner.id)).status).toBe(200);
    });
  });

  describe('legal hold', () => {
    it('refuses to delete a project that holds a held person’s files, or to remove such a file, or when the actor is held', async () => {
      const w = await world();
      await h.hold(w.editor);
      const project = await h.call(w.owner, 'DELETE', `/projects/${w.project.id}`);
      expect(project.status).toBe(409);
      expect(project.json.error.details).toEqual({ reason: 'legal_hold' });
      const file = await h.call(
        w.owner,
        'DELETE',
        `/projects/${w.project.id}/files/${w.editorFile.id}`,
      );
      expect(file.status).toBe(409);
      // The held person cannot delete either, not even the owner's file.
      expect(
        (await h.call(w.editor, 'DELETE', `/projects/${w.project.id}/files/${w.ownerFile.id}`))
          .status,
      ).toBe(409);
      // Nothing was removed.
      expect(await h.filesOf(w.project.id)).toHaveLength(2);
      // A file the held person did not add can still be removed by an unheld owner.
      await h.lift(w.editor);
      await h.hold(w.viewer);
      expect(
        (await h.call(w.owner, 'DELETE', `/projects/${w.project.id}/files/${w.editorFile.id}`))
          .status,
      ).toBe(200);
    });

    it('does not stop a transfer of ownership of files: removing a held editor’s share moves their files', async () => {
      const w = await world();
      await h.hold(w.editor);
      const removed = await h.ok(
        w.owner,
        'DELETE',
        `/projects/${w.project.id}/shares/${w.editorShare.id}`,
      );
      expect(removed.movedFiles).toBe(1);
      // The record is kept: moved, not deleted.
      expect(await h.filesOf(w.project.id)).toHaveLength(2);
    });
  });

  describe('the job', () => {
    it('is registered, runs every minute, and finds nothing in a tidy database', async () => {
      const job = lifecycleJobs().find(
        (candidate) => candidate.name === 'projects.reconcile-access',
      );
      expect(job?.intervalMs).toBe(60_000);
      await job!.run();
      expect(await reconcileAccessLeftovers(pool.db)).toBe(0);
    });
  });
});
