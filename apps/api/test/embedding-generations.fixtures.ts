import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase, DEFAULT_POST_FOLDER, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import { logger } from '../src/lib/logger.js';
import { inspectProjectFiles } from '../src/services/chat/attachment-context.js';
import { contextBudget, emptyCost } from '../src/services/chat/context-budget.js';
import { selectProjectFiles } from '../src/services/chat/project-context.js';
import {
  applyModelChoice,
  resetPreviousReleaseCache,
} from '../src/services/embeddings/generations.js';
import { embedPendingProjectPassages } from '../src/services/project-search/embedding.js';
import { indexProjectFile } from '../src/services/project-search/indexing.js';
import { invalidateSettingsCache } from '../src/services/settings.js';
import { type FakeEmbeddingModel, fakeEmbeddingModel } from './fake-embeddings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  seedOrganization,
  seedUser,
} from './live-postgres.js';

/**
 * Shared setup for the live embedding generation suites
 * (embedding-generations-*.live.test.ts): real PostgreSQL with pgvector and
 * deterministic fake embeddings models.
 *
 * Each test file declares its own `vi.mock` block and hoisted `state` (this
 * module's imports resolve through those mocks), and calls
 * `useEmbeddingGenerationsSuite(state)` inside its top-level `describe`.
 */
export interface EmbeddingGenerationsState {
  db: unknown;
  organizationId: string;
  fakes: Record<string, unknown>;
  pressure: string | null;
  pressureAfter: number | null;
  pressureChecks: number;
}

export const TARGET = 'AMBER-SEVEN';
export const QUESTION = 'Remind me: greenhouse heater startup password?';
export const PROVIDER = 'fake-provider';

export function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

export function facilities(): string {
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

export function ledger(marker: string, entries = 6): string {
  return Array.from({ length: entries }, (_, index) =>
    paragraph(
      `${marker} entry ${index}: stock of zebra xylophone quokka marmalade is catalogued alphabetically in the inventory`,
    ),
  ).join('\n\n');
}

export const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

export interface EmbeddingGenerationsContext {
  live: LiveDatabase;
  pool: ReturnType<typeof createDatabase>;
  owner: string;
  stranger: string;
  modelA: FakeEmbeddingModel;
  modelB: FakeEmbeddingModel;
}

/**
 * Registers the suite's hooks (a live database per file, generations, projects
 * and fake models reset before each test) and returns the helpers the tests
 * use. Call inside the top-level describe.
 */
export function useEmbeddingGenerationsSuite(state: EmbeddingGenerationsState) {
  const ctx = {} as EmbeddingGenerationsContext;

  async function configure(modelId: string, dimensions: number, extra: { enabled?: boolean } = {}) {
    await applyModelChoice(
      {
        enabled: extra.enabled ?? true,
        providerId: PROVIDER,
        modelId,
        dimensions,
        inputPriceMicros: null,
      },
      null,
    );
    invalidateSettingsCache();
  }

  async function project(name: string, userId = ctx.owner) {
    const [row] = await ctx.pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId, name })
      .returning();
    return row!;
  }

  async function projectFile(
    projectId: string,
    filename: string,
    text: string,
    options: { userId?: string; index?: boolean } = {},
  ) {
    const [row] = await ctx.pool.db
      .insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: options.userId ?? ctx.owner,
        projectId,
        filename,
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    if (options.index !== false) await indexProjectFile(row!.id);
    return row!;
  }

  async function facilitiesProject(name: string, userId = ctx.owner) {
    const target = await project(name, userId);
    const notes = await projectFile(target.id, 'facilities.txt', facilities(), { userId });
    const stock = await projectFile(target.id, 'ledger.txt', ledger('Ledger'), { userId });
    return { project: target, notes, stock };
  }

  async function select(target: { id: string; userId: string; name: string }, text = QUESTION) {
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
      text,
    );
  }

  const passageText = (selection: Awaited<ReturnType<typeof select>>) =>
    (selection.search?.passages ?? []).join('\n');

  async function expectMeaningSearch(target: { id: string; userId: string; name: string }) {
    const selection = await select(target);
    expect(selection.searchPart?.data.ranking).toBe('hybrid');
    expect(passageText(selection)).toContain(TARGET);
  }

  async function livePassages(): Promise<number> {
    const [row] = await ctx.pool.db.execute<{ total: number }>(sql`
      select count(*)::int as total from project_file_chunk c
      join attachment a on a.id = c.attachment_id
      where a.project_id is not null and a.deleted_at is null and a.upload_pending = false
    `);
    return Number(row?.total ?? 0);
  }

  async function rows(table: string, where = sql`true`) {
    const [exists] = await ctx.pool.db.execute<{ found: boolean }>(
      sql`select to_regclass(${table}) is not null as found`,
    );
    if (!exists?.found) return null;
    const [row] = await ctx.pool.db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)} where ${where}`,
    );
    return Number(row?.count ?? 0);
  }

  async function generations() {
    return ctx.pool.db
      .select()
      .from(schema.embeddingGeneration)
      .orderBy(schema.embeddingGeneration.id);
  }

  async function embedAll() {
    let total = 0;
    for (let run = 0; run < 20; run += 1) {
      const stored = await embedPendingProjectPassages();
      total += stored;
      if (stored === 0) return total;
    }
    throw new Error('The embedding job never finished');
  }

  /** Every post-deploy step recorded as finished: every replica runs this release. */
  async function finishUpgrade() {
    const journal = JSON.parse(readFileSync(join(DEFAULT_POST_FOLDER, 'journal.json'), 'utf8')) as {
      steps: Array<{ tag: string }>;
    };
    for (const step of journal.steps) {
      await ctx.pool.db.execute(sql`
        insert into oci_post_migration (name, checksum, started_at, finished_at, attempts)
        values (${step.tag}, 'test', now(), now(), 1)
        on conflict (name) do update set finished_at = now()
      `);
    }
    resetPreviousReleaseCache();
  }

  /** As during a rolling upgrade from v0.10: `migrate --post` has not run. */
  async function upgradeInProgress() {
    await ctx.pool.db.execute(sql`delete from oci_post_migration`);
    resetPreviousReleaseCache();
  }

  async function audits(action: string) {
    return ctx.pool.db
      .select({ metadata: schema.auditLog.metadata, actorUserId: schema.auditLog.actorUserId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.createdAt);
  }

  beforeAll(async () => {
    ctx.live = await createLiveDatabase('embedding_generations');
    ctx.pool = createDatabase(ctx.live.connectionString, { max: 12 });
    const { pool } = ctx;
    state.db = pool.db;
    await pool.db.execute(sql`create extension if not exists vector`);
    state.organizationId = await seedOrganization(pool.db);
    ctx.owner = await seedUser(pool.db, state.organizationId);
  });
  beforeEach(async () => {
    const { pool } = ctx;
    const tables = await pool.db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables
          where tablename like 'project_file_embedding%' and tablename <> 'project_file_embedding_failure'`,
    );
    for (const { name } of tables) await pool.db.execute(sql`drop table ${sql.identifier(name)}`);
    await pool.db.execute(sql`delete from embedding_generation`);
    await pool.db.execute(sql`delete from project`);
    await pool.db.execute(sql`delete from audit_log`);
    await pool.db.execute(sql`delete from instance_setting where key = 'embeddings'`);
    ctx.stranger = await seedUser(pool.db, state.organizationId);
    ctx.modelA = fakeEmbeddingModel({ modelId: 'model-a', dimensions: 16 });
    ctx.modelB = fakeEmbeddingModel({ modelId: 'model-b', dimensions: 12 });
    state.fakes = { 'model-a': ctx.modelA, 'model-b': ctx.modelB };
    state.pressure = null;
    state.pressureAfter = null;
    state.pressureChecks = 0;
    invalidateSettingsCache();
    await upgradeInProgress();
    vi.mocked(logger.warn).mockClear();
  });
  afterAll(async () => {
    await ctx.pool?.sql.end({ timeout: 1 });
    await ctx.live?.destroy();
  });

  return {
    ctx,
    configure,
    project,
    projectFile,
    facilitiesProject,
    select,
    passageText,
    expectMeaningSearch,
    livePassages,
    rows,
    generations,
    embedAll,
    finishUpgrade,
    upgradeInProgress,
    audits,
  };
}
