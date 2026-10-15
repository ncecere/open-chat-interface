import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeEmbeddingModel } from '../../../test/fake-embeddings.js';
import { type FakeReranker, startFakeReranker } from '../../../test/fake-reranker.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  budget,
  facilities,
  ledger,
  QUESTION,
  TARGET,
} from '../../../test/project-search-hybrid.fixtures.js';

/**
 * The search half of the project access matrix (v0.14, project sharing): every
 * way a conversation finds passages in a project's files, as each actor in the
 * spec's matrix. Real PostgreSQL with pgvector, the fake embeddings model and the
 * fake reranker. The files of this project were added by an editor, not by the
 * owner, so "the owner's files only" cannot be what makes these cells pass.
 *
 * Meaning-based search, keyword search, the vector store's own filter, reranking,
 * headings and the stored note are each a row; every row is run as the owner, a
 * direct editor, a direct viewer, an editor and a viewer through a group, an
 * outsider, an administrator and an auditor. Who pays is checked too: the
 * question's embedding and the reranking are the asker's, the passages' embedding
 * is the uploader's.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  embeddings: null as unknown,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/embeddings/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/embeddings/model.js')>()),
  resolveEmbeddingModel: async () => state.embeddings,
}));

const available = await livePostgresAvailable();
const { encryptSecret } = await import('../../lib/crypto.js');
const { updateSetting, invalidateSettingsCache } = await import('../../services/settings.js');
const { applyModelChoice, resolveGenerations } = await import(
  '../../services/embeddings/generations.js'
);
const { loadProjectContext, selectProjectFiles } = await import(
  '../../services/chat/project-context.js'
);
const { emptyCost } = await import('../../services/chat/context-budget.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');
const { embedPendingProjectPassages } = await import('../../services/project-search/embedding.js');
const { passageHeadings } = await import('../../services/project-search/excerpts.js');
const { projectSearchTerms, rankProjectChunks } = await import(
  '../../services/project-search/retrieval.js'
);
const { semanticProjectChunks } = await import('../../services/project-search/semantic.js');
const { vectorStore } = await import('../../services/vector-store/index.js');
const { fakeVector } = await import('../../../test/fake-embeddings.js');

const ACTORS = [
  'owner',
  'editor',
  'viewer',
  'groupEditor',
  'groupViewer',
  'outsider',
  'admin',
  'auditor',
] as const;
type Actor = (typeof ACTORS)[number];
const ROLE: Record<Actor, string> = {
  owner: 'user',
  editor: 'user',
  viewer: 'user',
  groupEditor: 'user',
  groupViewer: 'user',
  outsider: 'user',
  admin: 'admin',
  auditor: 'auditor',
};
const WITH_ACCESS: Actor[] = ['owner', 'editor', 'viewer', 'groupEditor', 'groupViewer'];

describe.skipIf(!available)('live: project access matrix, search', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let reranker: FakeReranker;
  const ids = {} as Record<Actor, string>;
  let project: { id: string; name: string };
  let facilitiesFile: string;
  let ledgerFile: string;
  const embedder = fakeEmbeddingModel();

  const scope = (actor: Actor, fileIds: string[]) => ({
    userId: ids[actor],
    projectId: project.id,
    fileIds,
  });

  async function usageOf(actor: Actor) {
    return pool.db.select().from(schema.usageEvent).where(eq(schema.usageEvent.userId, ids[actor]));
  }

  beforeAll(async () => {
    reranker = await startFakeReranker();
    live = await createLiveDatabase('project_access_search');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.embeddings = embedder;
    // The operator's step; OCI itself never creates the extension.
    await pool.db.execute(sql`create extension vector`);
    state.organizationId = await seedOrganization(pool.db);
    for (const actor of ACTORS) {
      ids[actor] = await seedUser(pool.db, state.organizationId, { role: ROLE[actor] });
    }
    const group = async (name: string, members: Actor[]) => {
      const [row] = await pool.db
        .insert(schema.group)
        .values({ organizationId: state.organizationId, name })
        .returning();
      for (const member of members) {
        await pool.db.insert(schema.groupMember).values({ groupId: row!.id, userId: ids[member] });
      }
      return row!.id;
    };
    const editors = await group('Editors', ['owner', 'groupEditor']);
    const viewers = await group('Viewers', ['owner', 'groupViewer']);
    const [created] = await pool.db
      .insert(schema.project)
      .values({ organizationId: state.organizationId, userId: ids.owner, name: 'Shared search' })
      .returning();
    project = created!;
    for (const [user, permission] of [
      [ids.editor, 'editor'],
      [ids.viewer, 'viewer'],
    ] as const) {
      await pool.db.execute(sql`
        insert into project_share (project_id, subject_type, subject_user_id, permission)
        values (${project.id}, 'person', ${user}, ${permission})`);
    }
    for (const [groupId, permission] of [
      [editors, 'editor'],
      [viewers, 'viewer'],
    ] as const) {
      await pool.db.execute(sql`
        insert into project_share (project_id, subject_type, subject_group_id, permission)
        values (${project.id}, 'group', ${groupId}, ${permission})`);
    }
    const file = async (actor: Actor, filename: string, text: string) => {
      const [row] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId: ids[actor],
          projectId: project.id,
          filename,
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(text),
          storageKey: randomUUID(),
          extractedText: text,
        })
        .returning();
      await indexProjectFile(row!.id);
      return row!.id;
    };
    // A heading above the paragraph that answers the question, for the headings row.
    const notes = facilities().split('\n\n');
    notes[6] = `## Boiler startup\n\n${notes[6]}`;
    // The facilities notes were added by an editor, the ledger by the owner.
    facilitiesFile = await file('editor', 'facilities.txt', notes.join('\n\n'));
    ledgerFile = await file('owner', 'ledger.txt', ledger());

    await applyModelChoice(
      {
        enabled: true,
        providerId: 'fake-provider',
        modelId: 'fake-embed',
        dimensions: 16,
        inputPriceMicros: null,
      },
      null,
    );
    invalidateSettingsCache();
    for (let run = 0; run < 20; run += 1) if ((await embedPendingProjectPassages()) === 0) break;

    const [provider] = await pool.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai-compatible',
        label: 'Local reranker',
        baseUrl: reranker.baseUrl,
        encryptedApiKey: encryptSecret('sk-local-rerank-key'),
      })
      .returning({ id: schema.provider.id });
    // As seeded on a real instance: files may reach the model.
    await updateSetting('features', {
      shareLinks: true,
      temporaryChat: true,
      webSearch: false,
      attachments: true,
      branching: true,
      memory: false,
    });
    await updateSetting('reranking', {
      enabled: true,
      providerId: provider!.id,
      modelId: 'bge-reranker-v2-m3',
      searchPriceMicros: null,
    });
    reranker.score = (_query, document) => (document.includes(TARGET) ? 0.98 : 0.02);
  });
  afterAll(async () => {
    await reranker?.close();
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  /** Each row returns what the actor got, as a short string. */
  const ROWS: Record<string, (actor: Actor) => Promise<string>> = {
    // Keyword search over the project's chunks.
    async keyword(actor) {
      const terms = await projectSearchTerms('conservatory boiler ignition passphrase');
      const chunks = await rankProjectChunks(scope(actor, [facilitiesFile, ledgerFile]), terms, 20);
      return chunks.some((chunk) => chunk.content.includes(TARGET)) ? 'found' : 'none';
    },
    // Meaning-based search: the paraphrase shares no word with the passage.
    async meaning(actor) {
      const chunks = await semanticProjectChunks(scope(actor, [facilitiesFile]), QUESTION, 20);
      return chunks?.some((chunk) => chunk.content.includes(TARGET)) ? 'found' : 'none';
    },
    // The vector store applies the person-and-project filter itself.
    async 'vector-store'(actor) {
      const { current } = await resolveGenerations({ fresh: true });
      const store = vectorStore();
      const filter = { personId: ids[actor], projectId: project.id, fileIds: [facilitiesFile] };
      const hits = await store.search(current!, filter, fakeVector(QUESTION), 20);
      const present = await store.hasVectors(current!, filter);
      return hits.length > 0 && present ? 'found' : hits.length === 0 && !present ? 'none' : 'odd';
    },
    // The whole pipeline a conversation uses: context, hybrid search, reranking, the note.
    async pipeline(actor) {
      const context = await loadProjectContext(project.id, {
        id: ids[actor],
        role: ROLE[actor] as 'user',
      });
      if (!context) return 'none';
      const selection = await selectProjectFiles(context, emptyCost(), budget, false, QUESTION);
      const text = (selection.search?.passages ?? []).join('\n');
      const data = selection.searchPart?.data;
      return text.includes(TARGET) && data?.ranking === 'hybrid' && data.reranked === true
        ? 'found'
        : `partial(${text.includes(TARGET)},${data?.ranking},${data?.reranked})`;
    },
    // Headings come from the file's text, for the files of a project the asker can read.
    async headings(actor) {
      const context = await loadProjectContext(project.id, {
        id: ids[actor],
        role: ROLE[actor] as 'user',
      });
      if (context) {
        const selection = await selectProjectFiles(context, emptyCost(), budget, false, QUESTION);
        const heading = selection.searchPart?.data.files.flatMap((f) => f.excerpts ?? [])[0]
          ?.heading;
        if (heading !== 'Boiler startup') return `note heading: ${heading}`;
      }
      // Direct: the same passage as the owner found it, asked for by the actor.
      const terms = await projectSearchTerms('conservatory boiler ignition passphrase');
      const chunks = await rankProjectChunks(scope('owner', [facilitiesFile]), terms, 5);
      const target = chunks.find((chunk) => chunk.content.includes(TARGET))!;
      // The passage text carries no heading of its own, so any heading found is the one the
      // database lookup read from the file's text before the passage: that read is what is checked.
      const map = await passageHeadings(
        [
          {
            attachmentId: target.attachmentId,
            // Just after the passage that follows the heading: the heading is in the lookback.
            start: target.end,
            text: 'The passage itself has no heading.',
          } as never,
        ],
        ids[actor],
      );
      return [...map.values()].includes('Boiler startup') ? 'found' : 'none';
    },
  };

  const EXPECTED: Record<string, (actor: Actor) => string> = {
    keyword: (actor) => (WITH_ACCESS.includes(actor) ? 'found' : 'none'),
    meaning: (actor) => (WITH_ACCESS.includes(actor) ? 'found' : 'none'),
    'vector-store': (actor) => (WITH_ACCESS.includes(actor) ? 'found' : 'none'),
    pipeline: (actor) => (WITH_ACCESS.includes(actor) ? 'found' : 'none'),
    headings: (actor) => (WITH_ACCESS.includes(actor) ? 'found' : 'none'),
  };

  for (const [row, run] of Object.entries(ROWS)) {
    describe(row, () => {
      for (const actor of ACTORS) {
        it(`${actor}: ${EXPECTED[row]!(actor)}`, async () => {
          expect(await run(actor)).toBe(EXPECTED[row]!(actor));
        });
      }
    });
  }

  it('has a row for every way of searching', () => {
    expect(Object.keys(ROWS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  describe('who pays', () => {
    it('charges the question and the reranking to the asker, never to the owner or the uploader', async () => {
      const before = {
        viewer: (await usageOf('viewer')).length,
        owner: (await usageOf('owner')).length,
        editor: (await usageOf('editor')).length,
      };
      const context = await loadProjectContext(project.id, { id: ids.viewer, role: 'user' });
      await selectProjectFiles(context, emptyCost(), budget, false, QUESTION);
      const after = {
        viewer: (await usageOf('viewer')).length,
        owner: (await usageOf('owner')).length,
        editor: (await usageOf('editor')).length,
      };
      // One event for the question's embedding and one for the reranking, both the viewer's.
      expect(after.viewer - before.viewer).toBe(2);
      expect(after.owner).toBe(before.owner);
      expect(after.editor).toBe(before.editor);
    });

    it('charges the passages’ embedding to the uploader, whoever can read them', async () => {
      const before = {
        editor: (await usageOf('editor')).length,
        owner: (await usageOf('owner')).length,
        viewer: (await usageOf('viewer')).length,
      };
      const text =
        'Greenhouse heater notes: the conservatory boiler needs the ignition passphrase.';
      const [row] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId: ids.editor,
          projectId: project.id,
          filename: 'late.txt',
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(text),
          storageKey: randomUUID(),
          extractedText: text,
        })
        .returning();
      await indexProjectFile(row!.id);
      for (let run = 0; run < 20; run += 1) if ((await embedPendingProjectPassages()) === 0) break;
      expect((await usageOf('editor')).length).toBeGreaterThan(before.editor);
      expect((await usageOf('owner')).length).toBe(before.owner);
      expect((await usageOf('viewer')).length).toBe(before.viewer);
    });
  });
});
