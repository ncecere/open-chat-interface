import { createDatabase, eq, schema, sql } from '@oci/db';

import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  REPLY,
  SVG_IMAGE,
  textStep,
  toolStep,
} from '../../../test/artifacts.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Artifacts (v0.9) through real PostgreSQL, the real chat, thread and
 * artifact routes, turn preparation, reply persistence, storage accounting,
 * exports and share links, with a scripted model in place of a provider.
 * This suite covers storage accounting and the artifact lifecycle; the shared fixtures live in
 * test/artifacts.fixtures.ts.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: ['tool_calling'] as string[],
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/models.js', () => ({
  resolveModelForRole: async (slug: string) => ({
    slug,
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 400_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
const defaults: Record<string, unknown> = {
  features: {
    webSearch: false,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  },
  search: { enabled: false, provider: null, baseUrl: null, encryptedApiKey: null, maxResults: 5 },
  chat: { defaultSystemPrompt: null },
  branding: { accentColor: '#3366ff' },
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key] ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? defaults[key] ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  beginChatRun: async () => 'unavailable',
}));

const available = await livePostgresAvailable();

const script = createScript(state);

describe.skipIf(!available)('live artifacts', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('artifacts_storage');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    // A second person, as in every artifacts suite; not addressed here.
    await seedUser(pool.db, state.organizationId);
    app = await buildArtifactsApp(state, () => owner);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
  });
  afterEach(async () => {
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from storage_policy`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const { artifactsOf, get, post, rows, seededReply, thread, turn, versionsOf } = artifactHelpers(
    state,
    () => ({ pool, owner, app }),
  );

  describe('storage', () => {
    it('counts artifact versions towards storage, except in the trash', async () => {
      const { getStorageUsage } = await import('../../services/storage/quota.js');
      const person = await seedUser(pool.db, state.organizationId);
      const { chat } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``, person);
      const bytes = Buffer.byteLength(SVG_IMAGE);
      expect(await getStorageUsage(person, 'user')).toMatchObject({
        liveBytes: bytes,
        artifactBytes: bytes,
        liveFileCount: 0,
        // Settings "Attachments" breaks the total down (v0.9.1).
        breakdown: {
          chatFiles: { bytes: 0, count: 0 },
          projectFiles: { bytes: 0, count: 0 },
          artifacts: { bytes, count: 1 },
        },
      });
      const { softDeleteThread, restoreThread } = await import('../../services/lifecycle/trash.js');
      await softDeleteThread(chat.id, person);
      expect((await getStorageUsage(person, 'user')).liveBytes).toBe(0);
      expect((await getStorageUsage(person, 'user')).breakdown?.artifacts).toEqual({
        bytes: 0,
        count: 0,
      });
      // Trashed conversations' artifacts are invisible.
      const [artifact] = await artifactsOf(chat.id);
      expect((await get(`/api/artifacts/${artifact!.id}`, person)).status).toBe(404);
      await restoreThread(chat.id, person);
      expect((await getStorageUsage(person, 'user')).liveBytes).toBe(bytes);
    });

    it('refuses an artifact that would exceed the storage allowance, and a restore that would', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      const chat = await thread(person);
      script(
        toolStep([
          ['c1', 'create_artifact', { title: 'Big', kind: 'markdown', content: 'x'.repeat(1_200) }],
        ]),
        textStep('Done.'),
      );
      const { reply } = await turn(chat.id, 'Big one', { user: person });
      const part = reply.parts.find((entry) => entry.type === 'tool-create_artifact');
      expect(part).toMatchObject({ state: 'output-error' });
      expect(String(part?.errorText)).toContain('storage limit');
      expect(await artifactsOf(chat.id)).toHaveLength(0);

      // Detected blocks over the allowance stay code blocks.
      const { chat: detected } = await seededReply(
        `\`\`\`svg\n<svg>${'y'.repeat(1_200)}</svg>\n\`\`\``,
        person,
      );
      expect(await artifactsOf(detected.id)).toHaveLength(0);

      // A restore that would put the person over the allowance is refused.
      await pool.db.execute(sql`delete from storage_policy`);
      const { chat: kept } = await seededReply(
        `\`\`\`svg\n<svg>${'z'.repeat(600)}</svg>\n\`\`\``,
        person,
      );
      const { softDeleteThread, restoreThread } = await import('../../services/lifecycle/trash.js');
      await softDeleteThread(kept.id, person);
      await seededReply(`\`\`\`svg\n<svg>${'w'.repeat(600)}</svg>\n\`\`\``, person);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      await expect(restoreThread(kept.id, person)).rejects.toMatchObject({ status: 422 });
    });

    it('includes artifacts in upload admission', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      await seededReply(`\`\`\`svg\n<svg>${'z'.repeat(900)}</svg>\n\`\`\``, person);
      await pool.db.insert(schema.storagePolicy).values({
        organizationId: state.organizationId,
        role: 'user',
        maxTotalBytes: 1_000,
      });
      state.settings.set('storage', {
        driver: 'local',
        maxFileBytes: 10_000_000,
        maxFilesPerMessage: 10,
        allowedMimeTypes: ['text/plain'],
      });
      const { uploadAttachment } = await import('../../services/attachments/upload.js');
      await expect(
        uploadAttachment({
          userId: person,
          role: 'user',
          filename: 'a.txt',
          declaredMimeType: 'text/plain',
          bytes: Buffer.from('x'.repeat(200)),
        }),
      ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('storage limit') });
    });
  });

  describe('lifecycle', () => {
    it('goes with its conversation, its reply and its owner', async () => {
      const { chat } = await seededReply(REPLY);
      const artifacts = await artifactsOf(chat.id);
      expect(artifacts).toHaveLength(3);
      await pool.db.delete(schema.thread).where(eq(schema.thread.id, chat.id));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
      const [orphanVersions] = await pool.db.execute<{ count: number }>(
        sql`select count(*)::int as count from artifact_version where artifact_id in ${artifacts.map((artifact) => artifact.id)}`,
      );
      expect(orphanVersions?.count).toBe(0);

      const person = await seedUser(pool.db, state.organizationId);
      const { chat: theirs } = await seededReply(REPLY, person);
      await pool.db.delete(schema.user).where(eq(schema.user.id, person));
      expect(await artifactsOf(theirs.id)).toHaveLength(0);
    });

    it('is purged with a trashed conversation', async () => {
      const { chat } = await seededReply(REPLY);
      const { softDeleteThread, purgeTrashedThread } = await import(
        '../../services/lifecycle/trash.js'
      );
      await softDeleteThread(chat.id, owner);
      expect(await artifactsOf(chat.id)).toHaveLength(3);
      await purgeTrashedThread(chat.id, owner);
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });

    it('is removed by conversation retention', async () => {
      const { chat } = await seededReply(REPLY);
      await pool.db
        .update(schema.thread)
        .set({ lastMessageAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })
        .where(eq(schema.thread.id, chat.id));
      state.settings.set('retention', { threadRetentionDays: 30, exemptPinnedThreads: true });
      const { applyThreadRetention } = await import('../../services/lifecycle/retention.js');
      const { purgeExpiredTrash } = await import('../../services/lifecycle/trash.js');
      expect(await applyThreadRetention()).toBeGreaterThan(0);
      // In the trash: kept, but no longer counted.
      expect(await artifactsOf(chat.id)).toHaveLength(3);
      await purgeExpiredTrash(new Date(Date.now() + 400 * 24 * 60 * 60 * 1000));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });

    it('is copied into forks with the versions made on the copied path', async () => {
      const { chat, reply } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      // A later reply, not part of a fork at the first reply, revises it.
      const [later] = await pool.db
        .insert(schema.message)
        .values({ threadId: chat.id, userId: owner, role: 'assistant', position: 3, parts: [] })
        .returning();
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: owner,
        role: 'user',
        content: '<svg><title>Later</title></svg>',
        source: 'reply',
        messageId: later!.id,
      });
      const response = await post(`/api/threads/${chat.id}/forks`, { messageId: reply.id });
      expect(response.status).toBe(201);
      const fork = ((await response.json()) as { thread: { id: string } }).thread;
      const [copy] = await artifactsOf(fork.id);
      expect(copy).toMatchObject({ sourceKey: 'block:0', kind: 'svg', currentVersion: 1 });
      expect(copy!.id).not.toBe(artifact!.id);
      const [copiedReply] = (await rows(fork.id)).filter((row) => row.role === 'assistant');
      expect(copy!.messageId).toBe(copiedReply!.id);
      expect((await versionsOf(copy!.id)).map((version) => version.content)).toEqual([SVG_IMAGE]);
    });
  });
});
