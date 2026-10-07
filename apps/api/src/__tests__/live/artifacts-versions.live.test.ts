import { createDatabase, eq, schema, sql } from '@oci/db';
import { MAX_ARTIFACT_BYTES } from '@oci/shared';
import { strFromU8, unzipSync } from 'fflate';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  HTML_PAGE,
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
 * This suite covers the versions API, exports and share links; the shared fixtures live in
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
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('artifacts_versions');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
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

  const { artifactsOf, get, post, seededReply, thread, turn, versionsOf } = artifactHelpers(
    state,
    () => ({
      pool,
      owner,
      app,
    }),
  );

  describe('versions API', () => {
    it('lists, reads and edits documents as new versions; HTML is changed through the model', async () => {
      const chat = await thread();
      script(
        toolStep([['c1', 'create_artifact', { title: 'Notes', kind: 'markdown', content: 'v1' }]]),
        textStep('Done.'),
      );
      // Short, so it is saved only because the person asked for an artifact (#149).
      await turn(chat.id, 'Notes in an artifact please');
      const list = (await (await get(`/api/artifacts?threadId=${chat.id}`)).json()) as {
        artifacts: Array<{ id: string; currentVersion: number; sizeBytes: number }>;
      };
      expect(list.artifacts).toHaveLength(1);
      const id = list.artifacts[0]!.id;
      expect(list.artifacts[0]).toMatchObject({ currentVersion: 1, sizeBytes: 2 });

      const edited = await post(`/api/artifacts/${id}/versions`, {
        content: 'v2 by me',
        baseVersion: 1,
      });
      expect(edited.status).toBe(201);
      const stale = await post(`/api/artifacts/${id}/versions`, {
        content: 'v2 again',
        baseVersion: 1,
      });
      expect(stale.status).toBe(409);

      const detail = (await (await get(`/api/artifacts/${id}`)).json()) as {
        content: string;
        artifact: { currentVersion: number };
        versions: Array<{ version: number; source: string; messageId: string | null }>;
      };
      expect(detail.content).toBe('v2 by me');
      expect(detail.versions.map((version) => [version.version, version.source])).toEqual([
        [2, 'person'],
        [1, 'reply'],
      ]);
      expect(detail.versions[0]!.messageId).toBeNull();
      const first = (await (await get(`/api/artifacts/${id}/versions/1`)).json()) as {
        content: string;
      };
      expect(first.content).toBe('v1');
      expect((await get(`/api/artifacts/${id}/versions/9`)).status).toBe(404);
      expect((await get(`/api/artifacts/${id}/versions/abc`)).status).toBe(404);

      const page = await seededReply(`\`\`\`html\n${HTML_PAGE}\n\`\`\``);
      const [html] = await artifactsOf(page.chat.id);
      const refused = await post(`/api/artifacts/${html!.id}/versions`, {
        content: '<p>x</p>',
        baseVersion: 1,
      });
      expect(refused.status).toBe(422);
    });

    it('refuses edits when the role switch is off and oversize documents', async () => {
      const chat = await thread();
      script(
        toolStep([['c1', 'create_artifact', { title: 'Doc', kind: 'markdown', content: 'v1' }]]),
        textStep('Done.'),
      );
      await turn(chat.id, 'Doc artifact');
      const [artifact] = await artifactsOf(chat.id);
      const big = await post(`/api/artifacts/${artifact!.id}/versions`, {
        content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1),
        baseVersion: 1,
      });
      expect(big.status).toBe(422);
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const off = await post(`/api/artifacts/${artifact!.id}/versions`, {
        content: 'v2',
        baseVersion: 1,
      });
      expect(off.status).toBe(403);
      // Reading stays possible: it is the person's own data.
      expect((await get(`/api/artifacts/${artifact!.id}`)).status).toBe(200);
    });

    it('returns 404 to everyone but the owner', async () => {
      const { chat } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      expect((await get(`/api/artifacts?threadId=${chat.id}`, stranger)).status).toBe(404);
      expect((await get(`/api/artifacts/${artifact!.id}`, stranger)).status).toBe(404);
      expect((await get(`/api/artifacts/${artifact!.id}/versions/1`, stranger)).status).toBe(404);
      expect(
        (
          await post(
            `/api/artifacts/${artifact!.id}/versions`,
            { content: 'x', baseVersion: 1 },
            stranger,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('exports and share links', () => {
    it('exports artifacts with every version in JSON and names them in Markdown', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const { chat, reply } = await seededReply(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``, person);
      const [artifact] = await artifactsOf(chat.id);
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: person,
        role: 'user',
        content: '<svg><title>Two</title></svg>',
        source: 'reply',
        messageId: reply.id,
      });
      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id, person);
      expect(markdown).toContain('_Artifact \u201cDot\u201d (SVG, version 1)_');
      expect(markdown).toContain('_Artifact \u201cDot\u201d (SVG, version 2)_');

      const { exportArchive } = await import('../../services/portability/export-archive.js');
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportArchive({ id: person })) chunks.push(chunk);
      const files = unzipSync(Buffer.concat(chunks));
      const json = Object.entries(files).find(
        ([name]) => name.startsWith('conversations/') && name.endsWith('.json'),
      );
      const exported = JSON.parse(strFromU8(json![1])) as {
        artifacts: Array<{
          id: string;
          kind: string;
          versions: Array<{ version: number; content: string }>;
        }>;
      };
      expect(exported.artifacts).toEqual([
        expect.objectContaining({
          id: artifact!.id,
          kind: 'svg',
          currentVersion: 2,
          versions: [
            expect.objectContaining({ version: 1, content: SVG_IMAGE }),
            expect.objectContaining({ version: 2, content: '<svg><title>Two</title></svg>' }),
          ],
        }),
      ]);
    });

    it('names the model as the app does and each artifact once in Markdown (#152)', async () => {
      const [provider] = await pool.db
        .insert(schema.provider)
        .values({ organizationId: state.organizationId, kind: 'openai', label: 'Walk3 export' })
        .returning();
      await pool.db.insert(schema.model).values({
        organizationId: state.organizationId,
        providerId: provider!.id,
        slug: 'artifact-model',
        upstreamModelId: 'artifact-model',
        displayName: 'Artifact Model 1',
      });
      const person = await seedUser(pool.db, state.organizationId);
      const chat = await thread(person);
      const report = `# Report\n\n${'A sentence of the report. '.repeat(30)}`;
      script(
        toolStep([
          ['c1', 'create_artifact', { title: 'Planets report', kind: 'markdown', content: report }],
        ]),
        textStep('Here is the report.'),
      );
      await turn(chat.id, 'Write the planets report as an artifact', { user: person });

      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id, person);
      expect(markdown).toContain('## Assistant \u00b7 Artifact Model 1');
      expect(markdown).not.toContain('artifact-model');
      expect(markdown.match(/Planets report/g)).toHaveLength(1);
      expect(markdown).toContain('_Artifact \u201cPlanets report\u201d (Document, version 1)_');
      expect(markdown).not.toContain('Created artifact');

      // The data export's Markdown files read the same.
      const { exportArchive } = await import('../../services/portability/export-archive.js');
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportArchive({ id: person })) chunks.push(chunk);
      const [, file] = Object.entries(unzipSync(Buffer.concat(chunks))).find(
        ([name]) => name.startsWith('conversations/') && name.endsWith('.md'),
      )!;
      const archived = strFromU8(file);
      expect(archived).toContain('## Assistant \u00b7 Artifact Model 1');
      expect(archived.match(/Planets report/g)).toHaveLength(1);

      await pool.db.delete(schema.provider).where(eq(schema.provider.id, provider!.id));
    });

    it('shares artifacts at the shared version, redacted, and nothing from outside the share', async () => {
      const secret = 'api_key=sk-live-1234567890abcdefghijklmnop';
      const svg = `<svg><title>Keys</title><text>${secret}</text></svg>`;
      const { chat, reply } = await seededReply(`\`\`\`svg\n${svg}\n\`\`\``);
      const [artifact] = await artifactsOf(chat.id);
      const { createShareLink, getPublicShare } = await import('../../services/share-links.js');
      const snapshot = await createShareLink(chat.id, owner, { upToMessageId: reply.id });
      // A later reply and a later person edit are not part of the snapshot.
      const [later] = await pool.db
        .insert(schema.message)
        .values({
          threadId: chat.id,
          userId: owner,
          role: 'assistant',
          position: 3,
          parts: [{ type: 'text', text: 'later' }],
        })
        .returning();
      const { addArtifactVersion } = await import('../../services/artifacts/store.js');
      await addArtifactVersion({
        artifactId: artifact!.id,
        userId: owner,
        role: 'user',
        content: '<svg><title>Later</title></svg>',
        source: 'reply',
        messageId: later!.id,
      });
      const shared = await getPublicShare(snapshot.slug);
      expect(shared.artifacts).toEqual([
        {
          messageId: reply.id,
          sourceKey: 'block:0',
          title: 'Keys',
          kind: 'svg',
          language: null,
          version: 1,
          content: expect.stringContaining('[REDACTED]'),
        },
      ]);
      expect(JSON.stringify(shared)).not.toContain('sk-live-1234567890');

      const liveLink = await createShareLink(chat.id, owner, {});
      const current = await getPublicShare(liveLink.slug);
      expect(current.artifacts[0]).toMatchObject({
        version: 2,
        content: '<svg><title>Later</title></svg>',
      });
    });

    it('returns the existing artifact for a repeated call, and enforces version and count limits', async () => {
      const { chat, reply } = await seededReply('No blocks here.');
      const { createArtifact, addArtifactVersion } = await import(
        '../../services/artifacts/store.js'
      );
      const input = {
        userId: owner,
        role: 'user' as const,
        threadId: chat.id,
        messageId: reply.id,
        sourceKey: 'tool:repeat',
        title: '  ',
        kind: 'svg' as const,
        content: '<svg/>',
      };
      const first = await createArtifact(input);
      const again = await createArtifact({ ...input, content: '<svg>other</svg>' });
      expect(first).toMatchObject({ created: true, artifact: { title: 'SVG', sizeBytes: 6 } });
      expect(again).toMatchObject({ created: false, artifact: { id: first.artifact.id } });
      expect(await versionsOf(first.artifact.id)).toHaveLength(1);
      await expect(
        createArtifact({ ...input, sourceKey: 'tool:empty', content: ' ' }),
      ).rejects.toMatchObject({
        status: 422,
      });

      await pool.db
        .update(schema.artifact)
        .set({ currentVersion: 100 })
        .where(eq(schema.artifact.id, first.artifact.id));
      await expect(
        addArtifactVersion({
          artifactId: first.artifact.id,
          userId: owner,
          role: 'user',
          content: '<svg/>',
          source: 'reply',
          messageId: reply.id,
        }),
      ).rejects.toMatchObject({ status: 422 });

      await pool.db.execute(sql`
        insert into artifact (user_id, thread_id, message_id, source_key, title, kind)
        select ${owner}, ${chat.id}, ${reply.id}, 'tool:fill-' || n, 'Fill', 'svg'
        from generate_series(1, 199) as n
      `);
      await expect(createArtifact({ ...input, sourceKey: 'tool:one-more' })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('at most 200 artifacts'),
      });
      // Detected blocks beyond the limit stay code blocks.
      const { saveDetectedArtifacts } = await import('../../services/artifacts/store.js');
      expect(
        await saveDetectedArtifacts({
          userId: owner,
          role: 'user',
          threadId: chat.id,
          messageId: reply.id,
          parts: [{ type: 'text', text: `\`\`\`svg\n${SVG_IMAGE}\n\`\`\`` }],
        }),
      ).toBe(0);
    });
  });
});
