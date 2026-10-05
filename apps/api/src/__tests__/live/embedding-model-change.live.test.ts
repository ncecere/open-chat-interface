import { randomUUID } from 'node:crypto';
import { createDatabase, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FakeEmbeddingModel, fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Reproduction for v0.11 design section 7: changing the embeddings model (here
 * to one of other dimensions) through the administration API must not empty
 * meaning-based search while the passages are embedded again. Before
 * generations, the table was dropped and re-created at once, so right after
 * the change a paraphrased question found nothing until the job had embedded
 * everything again.
 *
 * Uses only interfaces that existed before generations (the admin route, the
 * embedding job, project-file selection), so it runs against both.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  fakes: {} as Record<string, unknown>,
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
vi.mock('../../services/embeddings/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/embeddings/model.js')>()),
  resolveEmbeddingModel: async (_providerId: string, modelId: string) => state.fakes[modelId],
}));

const available = await livePostgresAvailable();
const { embeddingsRoutes } = await import('../../routes/admin/embeddings.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { contextBudget, emptyCost } = await import('../../services/chat/context-budget.js');
const { inspectProjectFiles } = await import('../../services/chat/attachment-context.js');
const { selectProjectFiles } = await import('../../services/chat/project-context.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { embedPendingProjectPassages } = await import('../../services/project-search/embedding.js');

const TARGET = 'AMBER-SEVEN';
const QUESTION = 'Remind me: greenhouse heater startup password?';

function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

function facilities(): string {
  return Array.from({ length: 10 }, (_, index) =>
    index === 6
      ? paragraph(
          `Conservatory boiler ignition passphrase is ${TARGET}; type it on the panel beside the boiler before warming begins`,
        )
      : paragraph(
          `Kitchen rota note ${index}: pantry shelves are tidied, dishes are washed and cooking area upkeep is logged by whoever is on duty`,
        ),
  ).join('\n\n');
}

const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

describe.skipIf(!available)('live: changing the embeddings model', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let owner: string;
  let providerId: string;
  let small: FakeEmbeddingModel;
  let large: FakeEmbeddingModel;

  beforeAll(async () => {
    live = await createLiveDatabase('embedding_model_change');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    await pool.db.execute(sql`create extension if not exists vector`);
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    const admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    const [provider] = await pool.db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'OpenAI' })
      .returning({ id: schema.provider.id });
    providerId = provider!.id;
    small = fakeEmbeddingModel({ modelId: 'embed-16', dimensions: 16 });
    large = fakeEmbeddingModel({ modelId: 'embed-24', dimensions: 24 });
    state.fakes = { 'embed-16': small, 'embed-24': large };
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: admin,
        role: 'admin',
        name: 'Admin',
        email: 'admin-model-change@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.use('*', requireAdmin);
    app.route('/embeddings', embeddingsRoutes);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function put(body: unknown) {
    const response = await app.request('/embeddings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    invalidateSettingsCache();
  }

  async function select(target: { id: string; userId: string; name: string }) {
    return selectProjectFiles(
      {
        id: target.id,
        userId: target.userId,
        name: target.name,
        instructions: '',
        files: await inspectProjectFiles(target.id, target.userId),
      },
      emptyCost(),
      budget,
      false,
      QUESTION,
    );
  }

  it('keeps finding passages by meaning right after a change to a model of other dimensions', async () => {
    const [project] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId: owner, name: 'Facilities' })
      .returning();
    const text = facilities();
    const [file] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: owner,
        projectId: project!.id,
        filename: 'facilities.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    await indexProjectFile(file!.id);

    await put({ enabled: true, providerId, modelId: 'embed-16' });
    while ((await embedPendingProjectPassages()) > 0) {
      // embeds every passage with the first model
    }
    const before = await select(project!);
    expect(before.searchPart?.data.ranking).toBe('hybrid');
    expect((before.search?.passages ?? []).join('\n')).toContain(TARGET);

    // The administrator chooses a model of other dimensions. Nothing has been
    // embedded with it yet.
    await put({ modelId: 'embed-24' });
    expect(large.embedded.filter((value) => value !== QUESTION).length).toBeLessThanOrEqual(1);

    const meanwhile = await select(project!);
    // Before generations: searchPart was null and the passage was not found
    // (keyword search alone cannot match the paraphrase).
    expect(meanwhile.searchPart?.data.ranking).toBe('hybrid');
    expect((meanwhile.search?.passages ?? []).join('\n')).toContain(TARGET);
  });
});
