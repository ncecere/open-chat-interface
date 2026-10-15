import { createDatabase, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classificationData,
  recordStatements,
  TOUCHES_CLASSIFICATION,
} from '../../../test/classification-data.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The resolver (#395) against a real database: every row of the spec's case
 * table, each source alone and combined, retired and kept labels, the
 * fallback scan while the backfill runs, fail closed, and mode `off` reading
 * nothing at all.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
  warnings: [] as unknown[][],
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: (...args: unknown[]) => state.warnings.push(args),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => state.settings.get(key) ?? {},
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live data classification: resolver', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let data: ReturnType<typeof classificationData>;
  let owner: string;
  let resolveClassification: typeof import('../../services/classification/resolve.js').resolveClassification;
  let loadClasses: typeof import('../../services/classification/resolve.js').loadClasses;
  let loadClassesForThreads: typeof import('../../services/classification/resolve.js').loadClassesForThreads;
  let resetReadinessCache: typeof import('../../services/migrations/readiness.js').resetReadinessCache;

  const mode = (value: 'off' | 'warn' | 'block', services: Record<string, string[]> = {}) =>
    state.settings.set('classification', { mode: value, services });
  const names = (classes: Array<{ name: string }>) => classes.map((entry) => entry.name).sort();

  beforeAll(async () => {
    live = await createLiveDatabase('classification_resolve');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    data = classificationData(pool, state.organizationId, owner);
    ({ resolveClassification, loadClasses, loadClassesForThreads } = await import(
      '../../services/classification/resolve.js'
    ));
    ({ resetReadinessCache } = await import('../../services/migrations/readiness.js'));
  });
  beforeEach(async () => {
    await data.clear();
    state.settings.clear();
    state.warnings = [];
    resetReadinessCache();
    // Finished by default: the fallback scan has its own tests.
    await data.run(sql`insert into background_migration (name, table_name, batch_size, pause_ms, status)
      values ('0.14.thread-connector-use', 'public.message', 100, 0, 'finished')`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  describe('the case table', () => {
    // Conversation classes, model approvals, mode: the result and what is missing.
    const cases: Array<{
      name: string;
      carried: string[];
      approved: string[];
      mode: 'off' | 'warn' | 'block';
      outcome: 'allow' | 'warn' | 'block';
      missing: string[];
    }> = [
      {
        name: 'nothing carried',
        carried: [],
        approved: [],
        mode: 'block',
        outcome: 'allow',
        missing: [],
      },
      {
        name: 'off',
        carried: ['Student'],
        approved: [],
        mode: 'off',
        outcome: 'allow',
        missing: [],
      },
      {
        name: 'approved for more',
        carried: ['Student'],
        approved: ['Student', 'Health'],
        mode: 'block',
        outcome: 'allow',
        missing: [],
      },
      {
        name: 'one of two',
        carried: ['Student', 'Health'],
        approved: ['Student'],
        mode: 'block',
        outcome: 'block',
        missing: ['Health'],
      },
      {
        name: 'a new model (deny by default)',
        carried: ['Student'],
        approved: [],
        mode: 'block',
        outcome: 'block',
        missing: ['Student'],
      },
      {
        name: 'warn',
        carried: ['Student'],
        approved: [],
        mode: 'warn',
        outcome: 'warn',
        missing: ['Student'],
      },
      {
        name: 'warn but approved',
        carried: ['Student'],
        approved: ['Student'],
        mode: 'warn',
        outcome: 'allow',
        missing: [],
      },
    ];
    for (const row of cases)
      it(row.name, async () => {
        const classes = new Map<string, string>();
        for (const name of new Set([...row.carried, ...row.approved]))
          classes.set(name, await data.dataClass(name));
        await data.model(
          'm1',
          row.approved.map((name) => classes.get(name)!),
        );
        const project = await data.project(row.carried.map((name) => classes.get(name)!));
        const chat = await data.thread({ projectId: project });
        mode(row.mode);
        const decision = await resolveClassification({
          threadId: chat,
          destination: { kind: 'model', slug: 'm1' },
        });
        expect(decision.outcome).toBe(row.outcome);
        expect(names(decision.missing)).toEqual(row.missing);
        expect(decision.mode).toBe(row.mode);
      });

    it('a retired class still counts', async () => {
      const student = await data.dataClass('Student', { retired: true });
      await data.model('m1');
      const chat = await data.thread({ projectId: await data.project([student]) });
      mode('block');
      const decision = await resolveClassification({
        threadId: chat,
        destination: { kind: 'model', slug: 'm1' },
      });
      expect(decision.outcome).toBe('block');
      expect(decision.missing[0]).toMatchObject({ name: 'Student', retired: true });
    });

    it('a slug with no model is approved for nothing', async () => {
      const student = await data.dataClass('Student');
      const chat = await data.thread({ projectId: await data.project([student]) });
      mode('block');
      expect(
        (
          await resolveClassification({
            threadId: chat,
            destination: { kind: 'model', slug: 'gone' },
          })
        ).outcome,
      ).toBe('block');
    });

    it('a tool about to run: the connector classes count before the use row exists', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1', [student]);
      await data.model('m2');
      const chat = await data.thread();
      mode('block');
      const allow = await resolveClassification({
        threadId: chat,
        destination: { kind: 'model', slug: 'm1' },
        extraClassIds: [student],
      });
      expect(allow.outcome).toBe('allow');
      expect(allow.classes[0]?.reasons).toEqual(['connector']);
      const block = await resolveClassification({
        threadId: chat,
        destination: { kind: 'model', slug: 'm2' },
        extraClassIds: [student],
      });
      expect(block.outcome).toBe('block');
    });

    it('services are approved per class in the setting, a share link never', async () => {
      const student = await data.dataClass('Student');
      const other = await data.dataClass('Other');
      const chat = await data.thread({ projectId: await data.project([student]) });
      mode('block', { webSearch: [student], embeddings: [other] });
      const service = (name: 'webSearch' | 'embeddings' | 'reranking') =>
        resolveClassification({ threadId: chat, destination: { kind: 'service', name } });
      expect((await service('webSearch')).outcome).toBe('allow');
      expect((await service('embeddings')).outcome).toBe('block');
      expect((await service('reranking')).outcome).toBe('block');
      expect(
        (await resolveClassification({ threadId: chat, destination: { kind: 'share' } })).outcome,
      ).toBe('block');
    });

    it('a project on its own (file embedding) is judged by its labels', async () => {
      const student = await data.dataClass('Student');
      const project = await data.project([student]);
      mode('block', { embeddings: [student] });
      expect(
        (
          await resolveClassification({
            projectId: project,
            destination: { kind: 'service', name: 'embeddings' },
          })
        ).outcome,
      ).toBe('allow');
      mode('block');
      expect(
        (
          await resolveClassification({
            projectId: project,
            destination: { kind: 'service', name: 'embeddings' },
          })
        ).outcome,
      ).toBe('block');
    });
  });

  describe('sources', () => {
    it('reports each source alone, and all of them together on one class', async () => {
      const student = await data.dataClass('Student');
      const health = await data.dataClass('Health');
      const sis = await data.connector('SIS', [student]);
      const project = await data.project([student], { locked: true });
      const chat = await data.thread({ projectId: project });
      await data.use(chat, sis);
      await data.label(chat, student, 'person');
      await data.label(chat, health, 'kept');
      const classes = await loadClasses({ threadId: chat });
      expect(classes.map((entry) => [entry.name, entry.reasons])).toEqual([
        ['Health', ['kept']],
        ['Student', ['project', 'connector', 'person']],
      ]);
      expect(classes.find((entry) => entry.name === 'Student')).toMatchObject({
        connectorNames: ['SIS'],
        locked: true,
      });
      expect(classes.find((entry) => entry.name === 'Health')?.origins).toEqual(['project']);
    });

    it('reads a connector classified after the conversation used it', async () => {
      const student = await data.dataClass('Student');
      const sis = await data.connector('SIS');
      const chat = await data.thread();
      await data.use(chat, sis);
      expect(await loadClasses({ threadId: chat })).toEqual([]);
      await data.run(
        sql`insert into connector_data_class (connector_id, data_class_id) values (${sis}, ${student})`,
      );
      expect(names(await loadClasses({ threadId: chat }))).toEqual(['Student']);
    });

    it('carries nothing for an unlabelled connector, project or thread', async () => {
      const sis = await data.connector('Wiki');
      const chat = await data.thread({ projectId: await data.project() });
      await data.use(chat, sis);
      expect(await loadClasses({ threadId: chat })).toEqual([]);
      expect(await loadClasses({})).toEqual([]);
    });

    it('follows a rename: ids are stable, the name is read now', async () => {
      const student = await data.dataClass('Student');
      const chat = await data.thread({ projectId: await data.project([student]) });
      await data.run(sql`update data_class set name = 'Pupil records' where id = ${student}`);
      expect(names(await loadClasses({ threadId: chat }))).toEqual(['Pupil records']);
    });
  });

  describe('labels kept when what gave them goes away (raw SQL, as a v0.13 replica writes)', () => {
    it('after the conversation is moved out of its project', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1');
      const chat = await data.thread({ projectId: await data.project([student]) });
      await data.run(sql`update thread set project_id = null where id = ${chat}`);
      mode('block');
      const decision = await resolveClassification({
        threadId: chat,
        destination: { kind: 'model', slug: 'm1' },
      });
      expect(decision.outcome).toBe('block');
      expect(decision.classes[0]?.reasons).toEqual(['kept']);
    });

    it('after the project is deleted', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1');
      const project = await data.project([student]);
      const chat = await data.thread({ projectId: project });
      await data.run(sql`delete from project where id = ${project}`);
      mode('block');
      expect(
        (
          await resolveClassification({
            threadId: chat,
            destination: { kind: 'model', slug: 'm1' },
          })
        ).outcome,
      ).toBe('block');
    });

    it('after the connector is deleted', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1');
      const sis = await data.connector('SIS', [student]);
      const chat = await data.thread();
      await data.use(chat, sis);
      await data.run(sql`delete from connector where id = ${sis}`);
      mode('block');
      const decision = await resolveClassification({
        threadId: chat,
        destination: { kind: 'model', slug: 'm1' },
      });
      expect(decision.outcome).toBe('block');
      expect(decision.classes[0]?.origins).toEqual(['connector: SIS']);
    });

    it('in a fork', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1');
      const sis = await data.connector('SIS', [student]);
      const parent = await data.thread();
      await data.use(parent, sis);
      const fork = await data.thread({ parentId: parent });
      mode('block');
      expect(
        (
          await resolveClassification({
            threadId: fork,
            destination: { kind: 'model', slug: 'm1' },
          })
        ).outcome,
      ).toBe('block');
    });
  });

  describe('the fallback scan while the backfill has not finished', () => {
    async function threadWithToolPart(type: string, extra: Record<string, unknown> = {}) {
      const chat = await data.thread();
      await data.run(sql`insert into message (id, thread_id, user_id, role, position, parts, status)
        values (${data.id()}, ${chat}, ${owner}, 'assistant', 0, ${JSON.stringify([
          { type, toolCallId: 'c1', state: 'output-available', ...extra },
        ])}::jsonb, 'complete')`);
      return chat;
    }
    const pending = () =>
      data.run(sql`update background_migration set status = 'running'
        where name = '0.14.thread-connector-use'`);

    it('finds a connector used before 0052 in the messages, and stops looking once finished', async () => {
      const student = await data.dataClass('Student');
      await data.connector('Docs', [student], 'docs');
      const chat = await threadWithToolPart('tool-mcp__docs__search');
      await pending();
      expect(names(await loadClasses({ threadId: chat }))).toEqual(['Student']);
      // Finished is permanent for a process: the use rows are the whole truth now.
      await data.run(sql`update background_migration set status = 'finished'`);
      resetReadinessCache();
      expect(await loadClasses({ threadId: chat })).toEqual([]);
    });

    it('reads a dynamic tool part and ignores tools that are not a connector’s', async () => {
      const student = await data.dataClass('Student');
      await data.connector('Docs', [student], 'docs');
      await pending();
      const dynamic = await threadWithToolPart('dynamic-tool', { toolName: 'mcp__docs__search' });
      expect(names(await loadClasses({ threadId: dynamic }))).toEqual(['Student']);
      for (const other of [
        await threadWithToolPart('tool-web_search'),
        await threadWithToolPart('dynamic-tool', { toolName: 'web_search' }),
        await threadWithToolPart('tool-mcp__unknown__thing'),
      ])
        expect(await loadClasses({ threadId: other })).toEqual([]);
    });

    it('ignores a part that is not in a list, and other tools beside a connector’s in the same message', async () => {
      const student = await data.dataClass('Student');
      await data.connector('Docs', [student], 'docs');
      await pending();
      // `parts` should be a list; a lone object that looks like a tool part is not a use.
      const lone = await data.thread();
      await data.run(sql`insert into message (id, thread_id, user_id, role, position, parts, status)
        values (${data.id()}, ${lone}, ${owner}, 'assistant', 0,
        '{"type":"tool-mcp__docs__search","toolCallId":"c1"}'::jsonb, 'complete')`);
      expect(await loadClasses({ threadId: lone })).toEqual([]);
      // One message with a built-in tool and a connector's: only the connector counts.
      const mixed = await data.thread();
      await data.run(sql`insert into message (id, thread_id, user_id, role, position, parts, status)
        values (${data.id()}, ${mixed}, ${owner}, 'assistant', 0, ${JSON.stringify([
          { type: 'tool-web_search', toolCallId: 'c1' },
          { type: 'dynamic-tool', toolName: 'mcp__', toolCallId: 'c2' },
          { type: 'tool-mcp__docs__search', toolCallId: 'c3' },
        ])}::jsonb, 'complete')`);
      expect(names(await loadClasses({ threadId: mixed }))).toEqual(['Student']);
    });

    it('is also what a not yet scheduled migration means', async () => {
      const student = await data.dataClass('Student');
      await data.connector('Docs', [student], 'docs');
      const chat = await threadWithToolPart('tool-mcp__docs__search');
      await data.run(sql`delete from background_migration`);
      expect(names(await loadClasses({ threadId: chat }))).toEqual(['Student']);
    });
  });

  describe('lists', () => {
    it('reads the classes of several conversations in one query, and none for none', async () => {
      const { loadClassesForThreads } = await import('../../services/classification/resolve.js');
      expect(await loadClassesForThreads([])).toEqual(new Map());
      const student = await data.dataClass('Student');
      const health = await data.dataClass('Health');
      const labelled = await data.thread({ projectId: await data.project([student]) });
      const plain = await data.thread();
      const both = await data.thread();
      await data.label(both, health);
      await data.label(both, student, 'kept');
      const recording = recordStatements(pool);
      let result: Awaited<ReturnType<typeof loadClassesForThreads>>;
      try {
        result = await loadClassesForThreads([labelled, plain, both]);
      } finally {
        recording.stop();
      }
      expect(recording.statements).toHaveLength(1);
      expect([...result.keys()].sort()).toEqual([labelled, both].sort());
      expect(names(result.get(labelled)!)).toEqual(['Student']);
      expect(names(result.get(both)!)).toEqual(['Health', 'Student']);
    });
  });

  describe('mode off, and failures', () => {
    it('reads none of the classification tables in mode off, even for a labelled conversation', async () => {
      const student = await data.dataClass('Student');
      const sis = await data.connector('SIS', [student]);
      const chat = await data.thread({ projectId: await data.project([student]) });
      await data.use(chat, sis);
      await data.label(chat, student);
      mode('off');
      const recording = recordStatements(pool);
      try {
        const decision = await resolveClassification({
          threadId: chat,
          destination: { kind: 'model', slug: 'm1' },
        });
        expect(decision).toMatchObject({ mode: 'off', outcome: 'allow', classes: [], missing: [] });
      } finally {
        recording.stop();
      }
      expect(recording.statements.filter((text) => TOUCHES_CLASSIFICATION.test(text))).toEqual([]);
      expect(recording.statements).toEqual([]);
    });

    it('an unset or unreadable setting is off', async () => {
      const student = await data.dataClass('Student');
      const chat = await data.thread({ projectId: await data.project([student]) });
      for (const stored of [undefined, { mode: 'strict' }, { mode: 42 }]) {
        if (stored) state.settings.set('classification', stored);
        else state.settings.delete('classification');
        expect(
          (
            await resolveClassification({
              threadId: chat,
              destination: { kind: 'model', slug: 'm1' },
            })
          ).mode,
        ).toBe('off');
      }
    });

    it('fails closed in block when the classes cannot be read, and allows (logging) in warn', async () => {
      const student = await data.dataClass('Student');
      await data.model('m1', [student]);
      const chat = await data.thread({ projectId: await data.project([student]) });
      const original = pool.sql.unsafe.bind(pool.sql);
      pool.sql.unsafe = (() => {
        throw new Error('read failed');
      }) as unknown as typeof pool.sql.unsafe;
      try {
        mode('block');
        await expect(
          resolveClassification({ threadId: chat, destination: { kind: 'model', slug: 'm1' } }),
        ).rejects.toThrow();
        mode('warn');
        const decision = await resolveClassification({
          threadId: chat,
          destination: { kind: 'model', slug: 'm1' },
        });
        expect(decision).toMatchObject({ mode: 'warn', outcome: 'allow' });
        expect(state.warnings).toHaveLength(1);
      } finally {
        pool.sql.unsafe = original as typeof pool.sql.unsafe;
      }
    });
  });
});
