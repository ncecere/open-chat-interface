import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { inspectProjectFiles } from '../src/services/chat/attachment-context.js';
import { contextBudget, emptyCost } from '../src/services/chat/context-budget.js';
import { selectProjectFiles } from '../src/services/chat/project-context.js';
import { applyModelChoice, resolveGenerations } from '../src/services/embeddings/generations.js';
import { embedPendingProjectPassages } from '../src/services/project-search/embedding.js';
import { indexProjectFile } from '../src/services/project-search/indexing.js';
import { invalidateSettingsCache } from '../src/services/settings.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  seedOrganization,
  seedUser,
} from './live-postgres.js';

/**
 * Shared fixtures for the live meaning-based project search suites
 * (project-search-hybrid-*.live.test.ts): the project texts, the two live
 * databases (without and with pgvector) and helpers over projects, files,
 * passages, usage and the embedding job. Each suite declares its own
 * `vi.mock` block and `state`; the services imported here are the mocked ones.
 */
export interface HybridState {
  db: unknown;
  organizationId: string;
  fake: unknown;
}

type Pool = ReturnType<typeof createDatabase>;

export interface HybridContext {
  pool: Pool;
  owner: string;
}

export const TARGET = 'AMBER-SEVEN';
export const QUESTION = 'Remind me: greenhouse heater startup password?';

/** One paragraph of roughly a chunk's length, so each lands in its own chunk. */
export function paragraph(sentence: string, count = 8): string {
  return Array.from({ length: count }, (_, index) => `${sentence} (${index + 1}).`).join(' ');
}

/**
 * Facilities notes where exactly one paragraph says how to start the
 * conservatory boiler. It shares no word with QUESTION, so keyword search
 * cannot find it; it shares meaning, so the fake embeddings model does.
 */
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

export function ledger(marker = 'Ledger'): string {
  return Array.from({ length: 6 }, (_, index) =>
    paragraph(
      `${marker} entry ${index}: stock of zebra xylophone quokka marmalade is catalogued alphabetically in the inventory`,
    ),
  ).join('\n\n');
}

/** An input budget of 3,200 units: the passage share (1,600) holds one passage. */
export const budget = contextBudget({ contextWindow: 3200 + 1000 + 512, maxOutputTokens: 1000 });

/**
 * A database without pgvector and one with it, sharing the organization and
 * owner ids so the mocks fit either. Sets `state.organizationId`.
 */
export async function createHybridDatabases(state: HybridState) {
  const [plain, vector] = await Promise.all([
    createLiveDatabase('hybrid_plain'),
    createLiveDatabase('hybrid_vector'),
  ]);
  const plainPool = createDatabase(plain.connectionString, { max: 8 });
  const vectorPool = createDatabase(vector.connectionString, { max: 8 });
  // The operator's step; OCI itself never creates the extension.
  await vectorPool.db.execute(sql`create extension vector`);
  const [plainOrg, vectorOrg] = await Promise.all([
    seedOrganization(plainPool.db),
    seedOrganization(vectorPool.db),
  ]);
  // Both databases get the same organization and owner ids, so the mocks fit either.
  await vectorPool.db.execute(
    sql`update organization set id = ${plainOrg} where id = ${vectorOrg}`,
  );
  state.organizationId = plainOrg;
  const owner = await seedUser(plainPool.db, plainOrg);
  await vectorPool.db.execute(
    sql`insert into "user" (id, name, email, email_verified, role, organization_id)
        values (${owner}, 'Owner', ${`${owner}@example.com`}, true, 'user', ${plainOrg})`,
  );
  return { plain, vector, plainPool, vectorPool, owner };
}

export async function destroyHybridDatabases(
  databases: { plain?: LiveDatabase; vector?: LiveDatabase },
  pools: { plainPool?: Pool; vectorPool?: Pool },
) {
  await pools.plainPool?.sql.end({ timeout: 1 });
  await pools.vectorPool?.sql.end({ timeout: 1 });
  await Promise.all([databases.plain?.destroy(), databases.vector?.destroy()]);
}

/** Helpers over the live database; `context` is read when each is called. */
export function hybridHelpers(state: HybridState, context: () => HybridContext) {
  /** As an administrator saving the Embeddings page (without the sample embedding). */
  async function configure(
    settings: Partial<{
      enabled: boolean;
      providerId: string;
      modelId: string;
      dimensions: number | null;
      inputPriceMicros: number | null;
    }>,
  ) {
    await applyModelChoice(
      {
        enabled: true,
        providerId: 'fake-provider',
        modelId: 'fake-embed',
        dimensions: 16,
        inputPriceMicros: null,
        ...settings,
      },
      null,
    );
    invalidateSettingsCache();
  }

  /** Forgets every generation and its table, as on an instance never configured. */
  async function resetGenerations() {
    const { pool } = context();
    const tables = await pool.db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables where tablename like 'project_file_embedding%' and tablename <> 'project_file_embedding_failure'`,
    );
    for (const { name } of tables) await pool.db.execute(sql`drop table ${sql.identifier(name)}`);
    await pool.db.execute(sql`delete from embedding_generation`);
    await pool.db.execute(sql`delete from instance_setting where key = 'embeddings'`);
    invalidateSettingsCache();
  }

  async function current() {
    const { current: generation } = await resolveGenerations({ fresh: true });
    if (!generation) throw new Error('No current generation');
    return generation;
  }

  async function project(name: string, userId = context().owner) {
    const [row] = await context()
      .pool.db.insert(schema.project)
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
    const [row] = await context()
      .pool.db.insert(schema.attachment)
      .values({
        organizationId: state.organizationId,
        userId: options.userId ?? context().owner,
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

  async function largeProject(name: string, userId = context().owner) {
    const target = await project(name, userId);
    const notes = await projectFile(target.id, 'facilities.txt', facilities(), { userId });
    const stock = await projectFile(target.id, 'ledger.txt', ledger(), { userId });
    return { project: target, notes, stock };
  }

  async function select(target: { id: string; userId: string; name: string }, text: string) {
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

  async function usageEvents(userId: string) {
    return context()
      .pool.db.select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.userId, userId))
      .orderBy(schema.usageEvent.occurredAt);
  }

  async function chunkContents(attachmentId: string): Promise<string[]> {
    const rows = await context()
      .pool.db.select({ content: schema.projectFileChunk.content })
      .from(schema.projectFileChunk)
      .where(eq(schema.projectFileChunk.attachmentId, attachmentId))
      .orderBy(schema.projectFileChunk.ordinal);
    return rows.map((row) => row.content);
  }

  async function embeddingRows() {
    return context().pool.db.execute<{
      attachment_id: string;
      ordinal: number;
      model_key: string;
    }>(
      sql`select attachment_id, ordinal, model_key from project_file_embedding order by attachment_id, ordinal`,
    );
  }

  /** Runs the job until nothing is left. */
  async function embedAll() {
    let total = 0;
    for (let run = 0; run < 20; run += 1) {
      const stored = await embedPendingProjectPassages();
      total += stored;
      if (stored === 0) return total;
    }
    throw new Error('The embedding job never finished');
  }

  return {
    configure,
    resetGenerations,
    current,
    project,
    projectFile,
    largeProject,
    select,
    passageText,
    usageEvents,
    chunkContents,
    embeddingRows,
    embedAll,
  };
}
