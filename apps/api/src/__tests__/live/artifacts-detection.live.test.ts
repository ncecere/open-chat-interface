import { createDatabase, sql } from '@oci/db';
import { MAX_ARTIFACT_BYTES } from '@oci/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  HTML_PAGE,
  REPLY,
  SVG_IMAGE,
  textStep,
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
 * This suite covers detection of artifacts in finished replies; the shared fixtures live in
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
    live = await createLiveDatabase('artifacts_detection');
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

  const { artifactsOf, seededReply, thread, turn, versionsOf, waitForArtifacts } = artifactHelpers(
    state,
    () => ({ pool, owner, app }),
  );

  describe('detection in finished replies', () => {
    it('saves HTML, SVG and Mermaid blocks of a few lines; ordinary code stays code', async () => {
      state.capabilities = [];
      const chat = await thread();
      script(textStep(REPLY));
      const { reply } = await turn(chat.id, 'Make me a page');
      const artifacts = await waitForArtifacts(chat.id, 3);
      expect(
        artifacts.map((artifact) => [artifact.sourceKey, artifact.kind, artifact.title]),
      ).toEqual([
        ['block:0', 'html', 'Sales & chart'],
        ['block:3', 'svg', 'Dot'],
        ['block:4', 'mermaid', 'Flowchart'],
      ]);
      expect(artifacts.every((artifact) => artifact.messageId === reply.id)).toBe(true);
      const [html] = await versionsOf(artifacts[0]!.id);
      expect(html).toMatchObject({
        version: 1,
        content: HTML_PAGE,
        sizeBytes: Buffer.byteLength(HTML_PAGE),
        source: 'reply',
        messageId: reply.id,
      });
    });

    it('is idempotent when the stored reply is processed again (replay or retried persistence)', async () => {
      const { chat, reply } = await seededReply(REPLY);
      const before = await artifactsOf(chat.id);
      expect(before).toHaveLength(3);
      const { saveDetectedArtifacts } = await import('../../services/artifacts/store.js');
      const again = await Promise.all(
        [1, 2, 3].map(() =>
          saveDetectedArtifacts({
            userId: owner,
            role: 'user',
            threadId: chat.id,
            messageId: reply.id,
            parts: reply.parts,
          }),
        ),
      );
      expect(again.reduce((sum, count) => sum + count, 0)).toBe(0);
      const after = await artifactsOf(chat.id);
      expect(after.map((artifact) => artifact.id)).toEqual(before.map((artifact) => artifact.id));
      for (const artifact of after) expect(await versionsOf(artifact.id)).toHaveLength(1);
    });

    it('gives a retried reply its own artifacts and keeps the replaced reply’s', async () => {
      state.capabilities = [];
      const chat = await thread();
      script(
        textStep(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``),
        textStep(`\`\`\`svg\n${SVG_IMAGE}\n\`\`\``),
      );
      const first = await turn(chat.id, 'Draw a dot');
      await waitForArtifacts(chat.id, 1);
      const prompt = first.stored.find((row) => row.role === 'user')!;
      const second = await turn(chat.id, 'Draw a dot', { regenerate: prompt.id });
      expect(second.reply.id).not.toBe(first.reply.id);
      const artifacts = await waitForArtifacts(chat.id, 2);
      expect(artifacts.map((artifact) => artifact.messageId).sort()).toEqual(
        [first.reply.id, second.reply.id].sort(),
      );
    });

    it('saves nothing when the role switch is off, or for restricted accounts by default', async () => {
      state.capabilities = [];
      state.settings.set('roleFeatures', { roles: { user: { artifacts: false } } });
      const chat = await thread();
      script(textStep(REPLY));
      await turn(chat.id, 'Make me a page');
      const restricted = await seedUser(pool.db, state.organizationId, { role: 'restricted' });
      const other = await thread(restricted);
      script(textStep(REPLY));
      await turn(other.id, 'Make me a page', { role: 'restricted', user: restricted });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await artifactsOf(chat.id)).toHaveLength(0);
      expect(await artifactsOf(other.id)).toHaveLength(0);
    });

    it('leaves oversize blocks as code', async () => {
      const big = `<svg>${'x'.repeat(MAX_ARTIFACT_BYTES)}</svg>`;
      const { chat } = await seededReply(`\`\`\`svg\n${big}\n\`\`\``);
      expect(await artifactsOf(chat.id)).toHaveLength(0);
    });
  });
});
