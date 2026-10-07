import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactHelpers,
  buildArtifactsApp,
  createScript,
  systemOf,
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
 * A document the person edited by hand reaches the model as it was saved
 * (#366): through real PostgreSQL, the real chat and artifact routes and turn
 * preparation, with a scripted model whose prompt is read.
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

describe.skipIf(!available)('live: hand-edited artifacts in the model context', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('artifacts_edited');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    app = await buildArtifactsApp(state, () => owner);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = ['tool_calling'];
  });
  afterEach(async () => {
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const { artifactsOf, post, thread, turn } = artifactHelpers(state, () => ({ pool, owner, app }));

  async function documentWithEdit() {
    const chat = await thread();
    script(
      toolStep([
        [
          'c1',
          'create_artifact',
          { title: 'Camp plan', kind: 'markdown', content: '# Camp plan\n- Pack bags' },
        ],
      ]),
      textStep('Made it.'),
    );
    await turn(chat.id, 'Camp plan in an artifact please');
    const [artifact] = await artifactsOf(chat.id);
    return { chat, id: artifact!.id };
  }

  it('gives the model the latest saved version after a hand edit, not the one it wrote', async () => {
    const { chat, id } = await documentWithEdit();
    const edit = await post(`/api/artifacts/${id}/versions`, {
      content: '# Camp plan\n- Pack bags\n- Badge: $5 deposit, refundable',
      baseVersion: 1,
    });
    expect(edit.status).toBe(201);

    const model = script(textStep('The badge needs a $5 deposit.'));
    await turn(chat.id, 'What does the artifact say about a badge or a deposit? Quote it.');
    const system = systemOf(model);
    expect(system).toContain('<edited-artifacts>');
    expect(system).toContain('Badge: $5 deposit, refundable');
    expect(system).toContain(`${id} \\"Camp plan\\" (Document, version 2):`);
    expect(system).toContain('Camp plan');
    expect(system).toContain('version 2');
  });

  it('keeps giving the latest version after the model changes it again', async () => {
    const { chat, id } = await documentWithEdit();
    await post(`/api/artifacts/${id}/versions`, {
      content: '# Camp plan\n- Pack bags\n- Badge: $5 deposit',
      baseVersion: 1,
    });
    script(
      toolStep([
        [
          'u1',
          'update_artifact',
          {
            artifactId: id,
            edits: [{ find: '- Pack bags', replace: '- Pack bags\n- Bring water' }],
          },
        ],
      ]),
      textStep('Added.'),
    );
    await turn(chat.id, 'Add a bullet Bring water');
    const [artifact] = await artifactsOf(chat.id);
    expect(artifact!.currentVersion).toBe(3);

    const model = script(textStep('Both are there.'));
    await turn(chat.id, 'List the bullets');
    const system = systemOf(model);
    expect(system).toContain('Bring water');
    expect(system).toContain('Badge: $5 deposit');
    expect(system).toContain('version 3');
    expect(system).not.toContain('version 2)');
  });

  it('adds nothing when the person has not edited the artifact', async () => {
    const { chat } = await documentWithEdit();
    const model = script(textStep('Fine.'));
    await turn(chat.id, 'Thanks');
    expect(systemOf(model)).not.toContain('edited-artifacts');
  });
});
