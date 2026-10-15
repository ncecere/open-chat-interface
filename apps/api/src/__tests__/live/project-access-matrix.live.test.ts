import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendix,
  handbook,
  KESTREL,
  modelText,
} from '../../../test/chat-project-search.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';
import { LocalStorageDriver } from '../../services/storage/local-driver.js';

/**
 * The project access matrix (v0.14, project sharing, #394), table-driven over
 * real PostgreSQL, the real Hono routes and the real chat turn preparation:
 * every actor x every action of SPEC-groups.md's matrix, for a direct share and
 * for the same permission reached through a group. The table is data: the
 * expectations below are the spec's matrix, cell by cell. Each cell calls the
 * real route (or assembles a real turn) and records what happened as a short
 * string, and every response that should not carry a canary is checked for the
 * canary words seeded in the instructions and the files.
 *
 * The meaning-based half (embeddings, reranking, headings) is in
 * project-access-search.live.test.ts.
 */
/** Parsed response bodies: shapes are asserted by the cells, not by the type system. */
type J = ReturnType<typeof JSON.parse>;

const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  driver: null as unknown,
  system: 'INSTANCE PROMPT',
  contextWindow: undefined as number | undefined,
  maxOutputTokens: undefined as number | undefined,
  roles: {} as Record<string, string>,
  profiles: {} as Record<string, { email: string; name: string }>,
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
    contextWindow: state.contextWindow,
    maxOutputTokens: state.maxOutputTokens,
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
  // No other replica: the mixed-version guard has its own tests.
  liveReplicas: async () => [],
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
    if (key === 'roleFeatures') return {};
    if (key === 'retention') return {};
    if (key === 'audit') return {};
    // Chat-wide settings keep their defaults; embeddings and reranking are off.
    if (key === 'chat' || key === 'embeddings' || key === 'reranking') return {};
    return {};
  },
  invalidateSettingsCache: () => {},
}));
vi.mock('../../services/storage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/storage/index.js')>()),
  getStorageDriver: async () => state.driver,
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => state.system,
}));
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
const { portabilityRoutes } = await import('../../routes/portability.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

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

const PEOPLE: Record<Actor, { name: string; role: string }> = {
  owner: { name: 'Olivia Owner', role: 'user' },
  editor: { name: 'Eddie Editor', role: 'user' },
  viewer: { name: 'Vera Viewer', role: 'user' },
  groupEditor: { name: 'Gina GroupEditor', role: 'user' },
  groupViewer: { name: 'Gus GroupViewer', role: 'user' },
  outsider: { name: 'Otto Outsider', role: 'user' },
  admin: { name: 'Ada Admin', role: 'admin' },
  auditor: { name: 'Aud Auditor', role: 'auditor' },
};

const INSTR = 'INSTR-CANARY-7f3a';
const FILE = {
  owner: 'FILE-CANARY-OWNER-91',
  editor: 'FILE-CANARY-EDITOR-92',
  groupEditor: 'FILE-CANARY-GROUP-93',
};

interface Fixture {
  id: string;
  name: string;
  /** This project's instruction canary: unique, so a project an actor came to own never muddies another's. */
  instr: string;
  files: { owner: string; editor: string; groupEditor: string };
  shares: { editor: string; viewer: string; groupEditor: string; groupViewer: string };
  threads: Record<'owner' | 'editor' | 'viewer', string>;
}

/**
 * Expected observations, one array per row in the order of ACTORS:
 * owner, editor, viewer, via-group editor, via-group viewer, outsider, admin, auditor.
 * `404` columns are the same three (outsider, admin, auditor).
 */
const no = (value: string): string[] => [value, value, value];
const MATRIX = {
  // In own list and sidebar ("Shared with me").
  list: ['owner', 'editor', 'viewer', 'editor', 'viewer', ...no('absent')],
  // Read name and instructions (and the summary says what the caller may do).
  read: ['200:owner', '200:editor', '200:viewer', '200:editor', '200:viewer', ...no('404')],
  // List files and download each of them.
  files: [
    '200/200/200/200',
    '200/200/200/200',
    '200/200/200/200',
    '200/200/200/200',
    '200/200/200/200',
    ...no('404/404/404/404'),
  ],
  // Use in an own conversation: whole files and the instructions.
  'use-whole': ['context', 'context', 'context', 'context', 'context', ...no('none')],
  // Use in an own conversation: files too large to include whole, searched by keyword, with the stored note.
  'use-search': [
    'passage+note',
    'passage+note',
    'passage+note',
    'passage+note',
    'passage+note',
    ...no('none'),
  ],
  // Start or move an own conversation into it; list own conversations in it.
  'own-thread': [
    '201/200/200',
    '201/200/200',
    '201/200/200',
    '201/200/200',
    '201/200/200',
    ...no('404/404/404'),
  ],
  // Read another person's conversation in it: never, for anyone.
  'others-thread': Array.from({ length: 8 }, () => '404'),
  // Rename.
  rename: [
    '200:changed',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    ...no('404:unchanged'),
  ],
  // Edit instructions (alone), and together with a rename.
  instructions: ['200/200', '200/403', '403/403', '200/403', '403/403', ...no('404/404')],
  // Upload a file (charged to the uploader).
  upload: ['201:self', '201:self', '403:none', '201:self', '403:none', ...no('404:none')],
  // Remove any file (the owner removes the editor's, everyone else the owner's).
  'remove-file': [
    '200:deleted',
    '200:deleted',
    '403:kept',
    '200:deleted',
    '403:kept',
    ...no('404:kept'),
  ],
  // Delete the project.
  delete: ['200:deleted', '403:kept', '403:kept', '403:kept', '403:kept', ...no('404:kept')],
  // Add a share (with the outsider).
  'share-add': ['201:added', '403:none', '403:none', '403:none', '403:none', ...no('404:none')],
  // Change a share (the viewer to editor).
  'share-change': [
    '200:changed',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    ...no('404:unchanged'),
  ],
  // Remove a share.
  'share-remove': [
    '200:removed',
    '403:kept',
    '403:kept',
    '403:kept',
    '403:kept',
    ...no('404:kept'),
  ],
  // Transfer to the direct editor.
  transfer: [
    '200:transferred',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    '403:unchanged',
    ...no('404:unchanged'),
  ],
  // See the share list: names for the owner, 403 for people with access, 404 otherwise.
  'share-list': ['200:names', '403', '403', '403', '403', ...no('404')],
  // The counts everyone with access may see, and nothing else.
  'access-info': [
    '200:owner:2/2',
    '200:editor:2/2',
    '200:viewer:2/2',
    '200:editor:2/2',
    '200:viewer:2/2',
    ...no('404'),
  ],
  // Leave: the owner cannot, a direct share can, access through a group cannot.
  leave: ['409', '200:gone', '200:gone', '409', '409', ...no('404')],
  // The personal data export: all files for the owner, only the ones they added otherwise.
  export: ['owner+editor+groupEditor', 'editor', 'none', 'groupEditor', 'none', ...no('none')],
} satisfies Record<string, string[]>;
type Row = keyof typeof MATRIX;

describe.skipIf(!available)('live: project access matrix', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let root: string;
  let driver: LocalStorageDriver;
  const runs = new Set<AcquiredRun>();
  const ids = {} as Record<Actor, string>;
  let groupEditors: string;
  let groupViewers: string;
  let readOnly: Fixture;
  let large: Fixture;
  let seq = 0;

  function appFor(actor: Actor) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: ids[actor],
        email: `${actor}@example.com`,
        name: PEOPLE[actor].name,
        image: null,
        role: PEOPLE[actor].role as 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/projects', projectRoutes);
    app.route('/api/threads', threadRoutes);
    app.route('/api/attachments', attachmentRoutes);
    app.route('/api/me', portabilityRoutes);
    return app;
  }

  async function call(actor: Actor, method: string, path: string, body?: unknown) {
    const response = await appFor(actor).request(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: safeJson(text) as J };
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function upload(actor: Actor, projectId: string, name: string, body: string) {
    const form = new FormData();
    form.append('files', new File([body], name, { type: 'text/plain' }));
    const response = await appFor(actor).request(`/api/projects/${projectId}/files`, {
      method: 'POST',
      body: form,
    });
    const text = await response.text();
    return { status: response.status, json: safeJson(text) as J };
  }

  /** Raw SQL on purpose: the seed must not depend on the code under test. */
  async function shareRow(
    projectId: string,
    subject: { user?: string; group?: string },
    permission: 'viewer' | 'editor',
  ) {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into project_share (project_id, subject_type, subject_user_id, subject_group_id, permission, created_by_user_id)
      values (${projectId}, ${subject.user ? 'person' : 'group'}, ${subject.user ?? null}, ${subject.group ?? null}, ${permission}, ${ids.owner})
      returning id
    `);
    return row!.id;
  }

  async function thread(actor: Actor, projectId: string | null) {
    const [row] = await pool.db
      .insert(schema.thread)
      .values({ userId: ids[actor], organizationId: state.organizationId, projectId })
      .returning();
    return row!;
  }

  /** A project with files, instructions, four shares and a conversation for each of three people. */
  async function seed(options: { big?: boolean } = {}): Promise<Fixture> {
    seq += 1;
    const created = await call('owner', 'POST', '/projects', {
      name: `Matrix ${seq}`,
      instructions: `Follow ${INSTR}-${seq} always.`,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.json.project.id as string;
    const shares = {
      editor: await shareRow(id, { user: ids.editor }, 'editor'),
      viewer: await shareRow(id, { user: ids.viewer }, 'viewer'),
      groupEditor: await shareRow(id, { group: groupEditors }, 'editor'),
      groupViewer: await shareRow(id, { group: groupViewers }, 'viewer'),
    };
    // Straight into the tables (and the real indexer): the seed must not depend on
    // the upload route's sharing rules, which are under test.
    const fileOf = async (actor: Actor, name: string, body: string) => {
      const [row] = await pool.db
        .insert(schema.attachment)
        .values({
          organizationId: state.organizationId,
          userId: ids[actor],
          projectId: id,
          filename: name,
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(body),
          storageKey: randomUUID(),
          extractedText: body,
        })
        .returning();
      await driver.put(row!.storageKey, Buffer.from(body), 'text/plain');
      const { indexProjectFile } = await import('../../services/project-search/indexing.js');
      await indexProjectFile(row!.id);
      return row!.id;
    };
    const files = options.big
      ? {
          owner: await fileOf('owner', 'handbook.txt', handbook()),
          editor: await fileOf('editor', 'appendix.txt', appendix()),
          groupEditor: await fileOf('groupEditor', 'group-notes.txt', `Notes ${FILE.groupEditor}`),
        }
      : {
          owner: await fileOf('owner', 'owner-notes.txt', `Owner notes ${FILE.owner}`),
          editor: await fileOf('editor', 'editor-notes.txt', `Editor notes ${FILE.editor}`),
          groupEditor: await fileOf(
            'groupEditor',
            'group-notes.txt',
            `Group notes ${FILE.groupEditor}`,
          ),
        };
    return {
      id,
      name: `Matrix ${seq}`,
      instr: `${INSTR}-${seq}`,
      files,
      shares,
      threads: {
        owner: (await thread('owner', id)).id,
        editor: (await thread('editor', id)).id,
        viewer: (await thread('viewer', id)).id,
      },
    };
  }

  /** What a turn of the actor's own conversation in the project hands the model. */
  async function turn(actor: Actor, projectId: string, text: string) {
    const { setupTurn } = await import('../../services/chat/setup-turn.js');
    const own = await thread(actor, projectId);
    try {
      const started = await setupTurn(
        { id: ids[actor], name: PEOPLE[actor].name, role: PEOPLE[actor].role as 'user' },
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
      return { started, text: await modelText(started) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function projectState(projectId: string) {
    const [row] = await pool.db
      .select({
        name: schema.project.name,
        instructions: schema.project.instructions,
        userId: schema.project.userId,
      })
      .from(schema.project)
      .where(eq(schema.project.id, projectId));
    return row ?? null;
  }

  async function usageOf(actor: Actor) {
    const [row] = await pool.db
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, ids[actor]));
    return Number(row?.liveBytes ?? 0);
  }

  async function shareExists(shareId: string) {
    const rows = await pool.db.execute(sql`select 1 from project_share where id = ${shareId}`);
    return rows.length > 0;
  }

  /** Every cell: what the actor sees and does, as a short string. */
  const CELLS: Record<Row, (actor: Actor, fx: Fixture) => Promise<string>> = {
    async list(actor, fx) {
      const own = await call(actor, 'GET', '/projects');
      const sidebar = await call(actor, 'GET', '/projects/sidebar');
      const labelOf = (body: J) => {
        if ((body?.projects ?? []).some((p: J) => p.id === fx.id)) return 'owner';
        const shared = (body?.shared ?? []).find((p: J) => p.id === fx.id);
        return shared ? String(shared.access) : 'absent';
      };
      const a = labelOf(own.json);
      const b = labelOf(sidebar.json);
      // A shared project must never be mistaken for an own one by an older bundle.
      if (a !== 'owner' && (own.json?.projects ?? []).some((p: J) => p.id === fx.id)) return 'LEAK';
      return a === b ? a : `inconsistent:${a}/${b}`;
    },

    async read(actor, fx) {
      const response = await call(actor, 'GET', `/projects/${fx.id}`);
      if (response.status !== 200) {
        expect(response.text, 'a refusal carries no content').not.toContain(INSTR);
        return String(response.status);
      }
      const project = response.json.project;
      const bad: string[] = [];
      if (actor !== 'owner' && project.ownerName !== PEOPLE.owner.name) bad.push('ownerName');
      if (project.instructions !== `Follow ${fx.instr} always.`) bad.push('instructions');
      if (/@example\.com/.test(response.text)) bad.push('email');
      return `200:${project.access}${bad.length ? `:BAD(${bad})` : ''}`;
    },

    async files(actor, fx) {
      const listed = await call(actor, 'GET', `/projects/${fx.id}/files`);
      const downloads = [] as number[];
      for (const id of Object.values(fx.files)) {
        const response = await appFor(actor).request(`/api/attachments/${id}/content`);
        const body = await response.text();
        if (response.status !== 200) expect(body).not.toMatch(/CANARY|Handbook/);
        downloads.push(response.status);
      }
      if (listed.status !== 200) expect(listed.text).not.toContain('notes.txt');
      const addedBy =
        listed.status === 200 ? listed.json.files.map((f: J) => f.addedBy).sort() : [];
      const names = ['Eddie Editor', 'Gina GroupEditor', 'Olivia Owner'];
      const shape =
        listed.status === 200 &&
        (JSON.stringify(addedBy) !== JSON.stringify(names) || /@example\.com/.test(listed.text))
          ? ':BAD(addedBy)'
          : '';
      return `${listed.status}/${downloads.join('/')}${shape}`;
    },

    async 'use-whole'(actor, fx) {
      const result = await turn(actor, fx.id, 'Summarise the notes.');
      if ('error' in result) return `error:${result.error}`;
      const system = result.started!.turn.system;
      const inInput = [FILE.owner, FILE.editor, FILE.groupEditor].map((c) =>
        result.text.includes(c),
      );
      const instr = system.includes(fx.instr);
      if (instr && inInput.every(Boolean)) return 'context';
      if (!instr && inInput.every((v) => !v)) return 'none';
      return `partial(instr=${instr},files=${inInput})`;
    },

    async 'use-search'(actor, fx) {
      state.contextWindow = 6000 + 1000 + 512;
      state.maxOutputTokens = 1000;
      const result = await turn(actor, fx.id, 'What is the launch code for Operation Kestrel?');
      if ('error' in result) return `error:${result.error}`;
      const found = result.text.includes(KESTREL);
      const note =
        result.started!.turn.projectSearchPart?.data.files.some((f) => f.name === 'handbook.txt') ??
        false;
      return found && note
        ? 'passage+note'
        : !found && !note
          ? 'none'
          : `partial(passage=${found},note=${note})`;
    },

    async 'own-thread'(actor, fx) {
      const created = await call(actor, 'POST', '/threads', { title: 'Mine', projectId: fx.id });
      const plain = await call(actor, 'POST', '/threads', { title: 'Plain' });
      const moved = await call(actor, 'PATCH', `/threads/${plain.json.thread.id}`, {
        projectId: fx.id,
      });
      const listed = await call(actor, 'GET', `/threads?projectId=${fx.id}`);
      const foreign = Object.values(fx.threads).filter(
        (_, i) => Object.keys(fx.threads)[i] !== actor,
      );
      const leak = listed.status === 200 && foreign.some((id) => listed.text.includes(id));
      return `${created.status}/${moved.status}/${listed.status}${leak ? ':FOREIGN' : ''}`;
    },

    async 'others-thread'(actor, fx) {
      const statuses = new Set<number>();
      for (const [owner, id] of Object.entries(fx.threads)) {
        if (owner === actor) continue;
        const response = await call(actor, 'GET', `/threads/${id}`);
        const exported = await call(actor, 'GET', `/threads/${id}/export`);
        statuses.add(response.status);
        statuses.add(exported.status);
      }
      return [...statuses].join(',');
    },

    async rename(actor, fx) {
      const response = await call(actor, 'PATCH', `/projects/${fx.id}`, {
        name: `Renamed by ${actor}`,
      });
      const after = await projectState(fx.id);
      return `${response.status}:${after?.name === fx.name ? 'unchanged' : 'changed'}`;
    },

    async instructions(actor, fx) {
      const first = await call(actor, 'PATCH', `/projects/${fx.id}`, {
        instructions: `New ${actor}`,
      });
      const second = await call(actor, 'PATCH', `/projects/${fx.id}`, {
        instructions: `Newer ${actor}`,
        name: `Named by ${actor}`,
      });
      const after = await projectState(fx.id);
      const wrong = actor !== 'owner' && after?.name !== fx.name ? '|NAME-CHANGED' : '';
      return `${first.status}/${second.status}${wrong}`;
    },

    async upload(actor, fx) {
      const before = { me: await usageOf(actor), owner: await usageOf('owner') };
      // The role's upload limit is not the matrix's business: one small file.
      const response = await upload(actor, fx.id, 'extra.txt', 'Extra file');
      const after = { me: await usageOf(actor), owner: await usageOf('owner') };
      if (response.status !== 201) return `${response.status}:none`;
      const self =
        actor === 'owner'
          ? after.me > before.me
          : after.me > before.me && after.owner === before.owner;
      return `201:${self ? 'self' : 'CHARGED-ELSEWHERE'}`;
    },

    async 'remove-file'(actor, fx) {
      const target = actor === 'owner' ? fx.files.editor : fx.files.owner;
      const response = await call(actor, 'DELETE', `/projects/${fx.id}/files/${target}`);
      const rows = await pool.db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, target));
      return `${response.status}:${rows.length === 0 ? 'deleted' : 'kept'}`;
    },

    async delete(actor, fx) {
      const response = await call(actor, 'DELETE', `/projects/${fx.id}`);
      return `${response.status}:${(await projectState(fx.id)) ? 'kept' : 'deleted'}`;
    },

    async 'share-add'(actor, fx) {
      const response = await call(actor, 'POST', `/projects/${fx.id}/shares`, {
        subject: { type: 'person', email: 'outsider@example.com' },
        permission: 'viewer',
      });
      const rows = await pool.db.execute(
        sql`select 1 from project_share where project_id = ${fx.id} and subject_user_id = ${ids.outsider}`,
      );
      return `${response.status}:${rows.length > 0 ? 'added' : 'none'}`;
    },

    async 'share-change'(actor, fx) {
      const response = await call(actor, 'PATCH', `/projects/${fx.id}/shares/${fx.shares.viewer}`, {
        permission: 'editor',
      });
      const [row] = await pool.db.execute<{ permission: string }>(
        sql`select permission from project_share where id = ${fx.shares.viewer}`,
      );
      return `${response.status}:${row?.permission === 'editor' ? 'changed' : 'unchanged'}`;
    },

    async 'share-remove'(actor, fx) {
      const response = await call(actor, 'DELETE', `/projects/${fx.id}/shares/${fx.shares.viewer}`);
      return `${response.status}:${(await shareExists(fx.shares.viewer)) ? 'kept' : 'removed'}`;
    },

    async transfer(actor, fx) {
      const response = await call(actor, 'POST', `/projects/${fx.id}/transfer`, {
        email: 'editor@example.com',
      });
      const after = await projectState(fx.id);
      return `${response.status}:${after?.userId === ids.editor ? 'transferred' : 'unchanged'}`;
    },

    async 'share-list'(actor, fx) {
      const response = await call(actor, 'GET', `/projects/${fx.id}/shares`);
      if (response.status !== 200) {
        expect(response.text).not.toMatch(/@example\.com|Eddie|Vera/);
        return String(response.status);
      }
      return /editor@example\.com/.test(response.text) ? '200:names' : '200:no-names';
    },

    async 'access-info'(actor, fx) {
      const response = await call(actor, 'GET', `/projects/${fx.id}/access`);
      if (response.status !== 200) return String(response.status);
      const info = response.json;
      const leaks = /@example\.com|Eddie|Vera|Gina|Gus|Otto/.test(
        // The caller's own name may appear nowhere in this body either; the owner's is the one allowed name.
        response.text.replace(PEOPLE.owner.name, ''),
      );
      return `200:${info.access}:${info.personShares}/${info.groupShares}${leaks ? ':LEAK' : ''}`;
    },

    async leave(actor, fx) {
      const response = await call(actor, 'POST', `/projects/${fx.id}/leave`);
      if (response.status !== 200) return String(response.status);
      const after = await call(actor, 'GET', `/projects/${fx.id}`);
      return `200:${after.status === 404 ? 'gone' : 'STILL-THERE'}`;
    },

    async export(actor, fx) {
      const response = await appFor(actor).request('/api/me/export');
      if (response.status !== 200) return `status ${response.status}`;
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const everything = Object.values(entries)
        .map((bytes) => strFromU8(bytes))
        .join('\n');
      const found = (['owner', 'editor', 'groupEditor'] as const).filter((who) =>
        everything.includes(FILE[who]),
      );
      if (actor !== 'owner' && everything.includes(fx.instr)) return 'INSTRUCTIONS-LEAKED';
      return found.length ? found.join('+') : 'none';
    },
  };

  /** Rows that change the project each get their own, so cells never depend on each other. */
  const DESTRUCTIVE: Row[] = [
    'rename',
    'instructions',
    'upload',
    'remove-file',
    'delete',
    'share-add',
    'share-change',
    'share-remove',
    'transfer',
    'leave',
  ];

  beforeAll(async () => {
    live = await createLiveDatabase('project_access_matrix');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    root = await mkdtemp(join(tmpdir(), 'oci-matrix-'));
    driver = new LocalStorageDriver(root);
    state.driver = driver;
    for (const actor of ACTORS) {
      ids[actor] = await seedUser(pool.db, state.organizationId, {
        email: `${actor}@example.com`,
        role: PEOPLE[actor].role,
      });
      await pool.db.execute(
        sql`update "user" set name = ${PEOPLE[actor].name} where id = ${ids[actor]}`,
      );
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
    // The owner belongs to both groups, as sharing with a group requires.
    groupEditors = await group('Editors', ['owner', 'groupEditor']);
    groupViewers = await group('Viewers', ['owner', 'groupViewer']);
    readOnly = await seed();
    large = await seed({ big: true });
  });
  beforeEach(() => {
    state.contextWindow = undefined;
    state.maxOutputTokens = undefined;
  });
  afterEach(async () => {
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

  for (const row of Object.keys(MATRIX) as Row[]) {
    describe(row, () => {
      for (const [index, actor] of ACTORS.entries()) {
        it(`${actor}: ${MATRIX[row][index]}`, async () => {
          const fixture = DESTRUCTIVE.includes(row)
            ? await seed()
            : row === 'use-search'
              ? large
              : readOnly;
          const observed = await CELLS[row](actor, fixture);
          // A cell that changed its own project (a transfer makes the editor its owner)
          // leaves nothing behind for the cells that read whole accounts, such as the export.
          if (DESTRUCTIVE.includes(row)) {
            await pool.db.execute(sql`delete from project where id = ${fixture.id}`);
          }
          expect(observed).toBe(MATRIX[row][index]);
        });
      }
    });
  }

  it('has a cell for every action and every person', () => {
    for (const row of Object.keys(MATRIX) as Row[])
      expect(MATRIX[row], row).toHaveLength(ACTORS.length);
    expect(Object.keys(CELLS).sort()).toEqual(Object.keys(MATRIX).sort());
  });
});
