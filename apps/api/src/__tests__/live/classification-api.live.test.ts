import { sql } from '@oci/db';
import { PROTECTED_AUDIT_ACTIONS } from '@oci/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  APPROVED_MODEL,
  type ClassificationState,
  UNAPPROVED_MODEL,
  useClassificationSuite,
} from '../../../test/classification.fixtures.js';
import { recordStatements, TOUCHES_CLASSIFICATION } from '../../../test/classification-data.js';
import { textStep } from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * The classification API (#395): administrators define classes, approve
 * models, label connectors and set the mode; people label their own
 * conversations and projects and read what a conversation carries. Who may do
 * what, what each change records, and what the counters say.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  settings: new Map<string, unknown>(),
  capabilities: ['tool_calling'] as string[],
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
vi.mock('../../services/models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/models.js')>()),
  resolveModelForRole: async (slug: string) => ({
    slug,
    displayName: slug,
    capabilities: state.capabilities,
    supportedEfforts: [],
    providerKind: 'openai',
    contextWindow: 64_000,
    maxOutputTokens: 1_000,
    languageModel: state.model,
  }),
}));
vi.mock('../../services/connectors/limits.js', () => ({
  CONNECTOR_LIMITS: {
    timeoutMs: 1_500,
    maxResponseBytes: 64 * 1024,
    maxResultChars: 2_000,
    maxTools: 200,
    maxSchemaChars: 64_000,
  },
}));
const defaults: Record<string, () => unknown> = {
  features: () => ({
    webSearch: false,
    attachments: true,
    shareLinks: true,
    temporaryChat: true,
    branching: true,
  }),
  search: () => ({ enabled: false, provider: null, baseUrl: null, encryptedApiKey: null }),
  chat: () => ({ defaultSystemPrompt: null }),
  roleFeatures: () => ({
    roles: Object.fromEntries(
      ['admin', 'auditor', 'user', 'restricted'].map((role) => [role, { artifacts: false }]),
    ),
  }),
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => state.settings.get(key) ?? defaults[key]?.() ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? defaults[key]?.() ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({ buildSystemPrompt: async () => '' }));
vi.mock('../../services/limits/rate-limit.js', () => ({
  chatRateLimit: async () => ({ allowed: true }),
  uploadRateLimit: async () => ({ allowed: true }),
  threadCreateRateLimit: async () => ({ allowed: true }),
}));
vi.mock('../../services/limits/concurrency.js', () => ({
  acquireStreamSlot: async () => ({ release: async () => {} }),
}));
vi.mock('../../services/chat-streams.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chat-streams.js')>()),
  beginChatRun: async () => 'unavailable',
  sharedRedis: async () => null,
}));

const available = await livePostgresAvailable();

interface AdminClass {
  id: string;
  name: string;
  description: string;
  retiredAt: string | null;
  modelCount: number;
  connectorCount: number;
  projectCount: number;
  threadCount: number;
}
interface Classification {
  mode: string;
  classes: Array<{
    id: string;
    name: string;
    reasons: string[];
    removable?: boolean;
    locked?: boolean;
    connectorNames?: string[];
    origins?: string[];
  }>;
  models: Array<{ slug: string; status: string; missing: Array<{ name: string }> }>;
}

/** A response body as these tests read it. */
interface Body {
  error: { message: string; details: unknown };
  classes: Array<{ locked: boolean }>;
  links: Array<{ paused: boolean }>;
}
const body = async (response: Response) => (await response.json()) as Body;

describe.skipIf(!available)('live data classification: the API', () => {
  const suite = useClassificationSuite(state as ClassificationState);
  const {
    ctx,
    call,
    ok,
    script,
    createClass,
    approve,
    carry,
    setMode,
    createProject,
    labelProject,
    labelThread,
    projectThread,
    send,
    accepted,
    blocked,
    docsConnector,
    createConnector,
    auditsOf,
    thread,
  } = suite;

  const classification = (query: string, user = ctx.alice) =>
    ok<Classification>(call('GET', `/api/classification?${query}`, { user }));
  const adminClasses = async () =>
    (await ok<{ classes: AdminClass[] }>(call('GET', '/api/admin/data-classes'))).classes;
  const removeLabel = (threadId: string, classId: string, user = ctx.alice) =>
    call('DELETE', `/api/threads/${threadId}/data-classes/${classId}`, { user });
  const markBackfillScheduled = () =>
    ctx.pool.db.execute(sql`insert into background_migration (name, table_name, batch_size, pause_ms, status)
      values ('0.14.thread-connector-use', 'public.message', 100, 0, 'pending')
      on conflict (name) do nothing`);
  const resetBackfill = () =>
    ctx.pool.db.execute(
      sql`delete from background_migration where name = '0.14.thread-connector-use'`,
    );

  describe('administrators define classes', () => {
    it('creates, lists with usage, renames, retires and deletes, each audited with names', async () => {
      const created = await ok<AdminClass>(
        call('POST', '/api/admin/data-classes', {
          body: { name: 'Student records', description: 'Grades and enrolment' },
        }),
        201,
      );
      expect(created).toMatchObject({
        name: 'Student records',
        description: 'Grades and enrolment',
        retiredAt: null,
        modelCount: 0,
        connectorCount: 0,
        projectCount: 0,
        threadCount: 0,
      });

      // Where it is used shows in the counts.
      await approve(APPROVED_MODEL, [created.id]);
      const connector = await docsConnector({ reviewed: true });
      await carry(connector, [created.id]);
      const project = await createProject(ctx.alice);
      await labelProject(ctx.alice, project.id, [created.id]);
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, created.id);
      expect((await adminClasses())[0]).toMatchObject({
        modelCount: 1,
        connectorCount: 1,
        projectCount: 1,
        threadCount: 1,
      });

      // A rename keeps the id, so labels follow; the audit entry names both.
      const renamed = await ok<AdminClass>(
        call('PATCH', `/api/admin/data-classes/${created.id}`, { body: { name: 'Pupil records' } }),
      );
      expect(renamed).toMatchObject({ id: created.id, name: 'Pupil records' });
      setMode('warn');
      expect(
        (await classification(`threadId=${chat.id}`)).classes.map((entry) => entry.name),
      ).toEqual(['Pupil records']);
      setMode('off');
      const [update] = await auditsOf('data_class.update');
      expect(update?.metadata).toMatchObject({
        changes: { name: { before: 'Student records', after: 'Pupil records' } },
      });

      const retired = await ok<AdminClass>(
        call('POST', `/api/admin/data-classes/${created.id}/retire`),
      );
      expect(retired.retiredAt).not.toBeNull();
      await call('POST', `/api/admin/data-classes/${created.id}/retire`);
      expect(await auditsOf('data_class.retire')).toHaveLength(1);

      // Nothing is deleted while anything refers to it, and there is no force.
      const refused = await call('DELETE', `/api/admin/data-classes/${created.id}`);
      expect(refused.status).toBe(409);
      expect((await body(refused)).error.details).toEqual({
        connectors: 1,
        projects: 1,
        threads: 1,
      });
      await removeLabel(chat.id, created.id);
      await labelProject(ctx.alice, project.id, []);
      await carry(connector, [], true);
      await ok(call('DELETE', `/api/admin/data-classes/${created.id}`));
      expect(await adminClasses()).toEqual([]);
      // The approval went with it.
      expect(await ctx.pool.db.execute(sql`select 1 from model_data_class`)).toHaveLength(0);
      expect((await auditsOf('data_class.delete'))[0]?.metadata).toMatchObject({
        name: 'Pupil records',
      });
      expect((await auditsOf('data_class.create'))[0]?.metadata).toEqual({
        name: 'Student records',
      });
    });

    it('refuses a duplicate name in any case, bad input and an unknown class', async () => {
      await createClass('Student records');
      const duplicate = await call('POST', '/api/admin/data-classes', {
        body: { name: 'STUDENT RECORDS' },
      });
      expect(duplicate.status).toBe(409);
      for (const body of [
        { name: '' },
        { name: 'x'.repeat(61) },
        { name: 'Fine', description: 'x'.repeat(281) },
        { name: 'Fine', surprise: true },
      ])
        expect((await call('POST', '/api/admin/data-classes', { body })).status).toBe(422);
      const other = await createClass('Other');
      expect(
        (
          await call('PATCH', `/api/admin/data-classes/${other.id}`, {
            body: { name: 'student records' },
          })
        ).status,
      ).toBe(409);
      expect(
        (await call('PATCH', `/api/admin/data-classes/${other.id}`, { body: {} })).status,
      ).toBe(422);
      for (const [method, path] of [
        ['PATCH', '/api/admin/data-classes/nope'],
        ['POST', '/api/admin/data-classes/nope/retire'],
        ['DELETE', '/api/admin/data-classes/nope'],
      ] as const)
        expect(
          (await call(method, path, { body: method === 'PATCH' ? { name: 'x' } : undefined }))
            .status,
        ).toBe(404);
    });

    it('limits how many an instance defines', async () => {
      for (let index = 0; index < 100; index += 1)
        await ctx.pool.db.execute(
          sql`insert into data_class (organization_id, name) values (${state.organizationId}, ${`Class ${index}`})`,
        );
      const over = await call('POST', '/api/admin/data-classes', {
        body: { name: 'One too many' },
      });
      expect(over.status).toBe(422);
    });

    it('keeps the administrators’ changes out of retention', () => {
      for (const action of [
        'data_class.create',
        'data_class.update',
        'data_class.retire',
        'data_class.delete',
        'model.data_classes.update',
        'connector.data_classes.update',
        'settings.classification.update',
        'project.data_classes.update',
      ])
        expect(PROTECTED_AUDIT_ACTIONS as readonly string[]).toContain(action);
      for (const action of [
        'thread.data_class.add',
        'thread.data_class.remove',
        'classification.block',
      ])
        expect(PROTECTED_AUDIT_ACTIONS as readonly string[]).not.toContain(action);
    });
  });

  describe('the mode', () => {
    it('starts off, and warn or block wait for the upgrade to finish (409), then work', async () => {
      await resetBackfill();
      const initial = await ok<Record<string, unknown>>(call('GET', '/api/admin/classification'));
      expect(initial).toMatchObject({
        mode: 'off',
        services: { webSearch: [], embeddings: [], reranking: [] },
        modeAvailable: false,
        backfillDone: false,
      });
      for (const mode of ['warn', 'block'])
        expect((await call('PATCH', '/api/admin/classification', { body: { mode } })).status).toBe(
          409,
        );
      // Off is always allowed.
      await ok(call('PATCH', '/api/admin/classification', { body: { mode: 'off' } }));

      await markBackfillScheduled();
      const turnedOn = await ok<{ mode: string; modeAvailable: boolean }>(
        call('PATCH', '/api/admin/classification', { body: { mode: 'warn' } }),
      );
      expect(turnedOn).toMatchObject({ mode: 'warn', modeAvailable: true });
      const audit = (await auditsOf('settings.classification.update')).at(-1);
      expect(audit?.metadata).toMatchObject({ mode: { before: 'off', after: 'warn' } });
      await resetBackfill();
    });

    it('approves outside services per class, by name in the audit, and refuses an unknown class', async () => {
      await markBackfillScheduled();
      const student = await createClass('Student records');
      const result = await ok<{ services: Record<string, string[]> }>(
        call('PATCH', '/api/admin/classification', {
          body: { services: { webSearch: [student.id] } },
        }),
      );
      expect(result.services).toEqual({ webSearch: [student.id], embeddings: [], reranking: [] });
      const [audit] = await auditsOf('settings.classification.update');
      expect(audit?.metadata).toMatchObject({
        services: { webSearch: { before: [], after: ['Student records'] } },
      });
      expect(
        (
          await call('PATCH', '/api/admin/classification', {
            body: { services: { embeddings: ['nope'] } },
          })
        ).status,
      ).toBe(422);
      expect((await call('PATCH', '/api/admin/classification', { body: {} })).status).toBe(422);
      expect(
        (await call('PATCH', '/api/admin/classification', { body: { mode: 'strict' } })).status,
      ).toBe(422);
      await resetBackfill();
    });

    it('counts connectors nobody has reviewed', async () => {
      await docsConnector();
      expect(
        (await ok<{ unreviewedConnectorCount: number }>(call('GET', '/api/admin/classification')))
          .unreviewedConnectorCount,
      ).toBe(1);
    });
  });

  describe('models and connectors', () => {
    it('approves a model for classes by replacing the list; a new model is approved for nothing', async () => {
      const student = await createClass('Student records');
      const health = await createClass('Health records');
      const listed = () =>
        ok<{ models: Array<{ slug: string; dataClassIds: string[] }> }>(
          call('GET', '/api/admin/models'),
        ).then((body) => Object.fromEntries(body.models.map((m) => [m.slug, m.dataClassIds])));
      expect(await listed()).toMatchObject({ [APPROVED_MODEL]: [], [UNAPPROVED_MODEL]: [] });
      await approve(APPROVED_MODEL, [student.id, health.id, student.id]);
      expect((await listed())[APPROVED_MODEL]?.sort()).toEqual([student.id, health.id].sort());
      await approve(APPROVED_MODEL, [health.id]);
      expect((await listed())[APPROVED_MODEL]).toEqual([health.id]);
      const [audit] = (await auditsOf('model.data_classes.update')).slice(-1);
      expect(audit?.metadata).toMatchObject({
        slug: APPROVED_MODEL,
        before: ['Health records', 'Student records'],
        after: ['Health records'],
      });
      const put = (id: string, classIds: string[]) =>
        call('PUT', `/api/admin/models/${id}/data-classes`, { body: { classIds } });
      expect((await put('nope', [])).status).toBe(404);
      expect((await put(suite.models.get(APPROVED_MODEL)!, ['nope'])).status).toBe(422);
      await ok(call('POST', `/api/admin/data-classes/${health.id}/retire`));
      // An existing approval of a retired class stays; a new one is refused.
      expect((await put(suite.models.get(APPROVED_MODEL)!, [health.id])).status).toBe(200);
      expect((await put(suite.models.get(UNAPPROVED_MODEL)!, [health.id])).status).toBe(422);
    });

    it('requires a new connector to say what it carries once classification is on, and records review', async () => {
      const student = await createClass('Student records');
      // Off: as in v0.13.
      const before = await createConnector({ name: 'Plain', slug: 'plain' });
      expect(before).toMatchObject({ reviewed: false, dataClassIds: [] });
      setMode('warn');
      const refused = await call('POST', '/api/admin/connectors', {
        body: { name: 'Wiki', url: ctx.mcp.url, allowPrivateNetwork: true },
      });
      expect(refused.status).toBe(422);
      const none = await createConnector({ name: 'Wiki', slug: 'wiki', reviewed: true });
      expect(none).toMatchObject({ reviewed: true, dataClassIds: [] });
      const carries = await createConnector({
        name: 'SIS',
        slug: 'sis',
        dataClassIds: [student.id],
      });
      expect(carries).toMatchObject({ reviewed: true, dataClassIds: [student.id] });

      // Changing it later: the list is replaced, an empty list with no review is "not reviewed".
      await carry(carries, [], false);
      const listed = await ok<{ connectors: Array<{ slug: string; reviewed: boolean }> }>(
        call('GET', '/api/admin/connectors'),
      );
      expect(listed.connectors.find((c) => c.slug === 'sis')).toMatchObject({ reviewed: false });
      await carry(carries, [], true);
      expect(
        (await ok<{ reviewed: boolean }>(call('GET', `/api/admin/connectors/${carries.id}`)))
          .reviewed,
      ).toBe(true);
      const audits = await auditsOf('connector.data_classes.update');
      expect(audits.at(-1)?.metadata).toMatchObject({
        slug: 'sis',
        before: [],
        after: [],
        reviewed: true,
      });
      const put = (id: string, body: unknown) =>
        call('PUT', `/api/admin/connectors/${id}/data-classes`, { body });
      expect((await put('nope', { classIds: [], reviewed: true })).status).toBe(404);
      expect((await put(carries.id, { classIds: ['nope'], reviewed: true })).status).toBe(422);
      expect((await put(carries.id, { classIds: [] })).status).toBe(422);
    });

    it('a deleted connector leaves its classes on the conversations that used it, which the person cannot remove', async () => {
      const student = await createClass('Student records');
      const connector = await docsConnector({ reviewed: true });
      await carry(connector, [student.id]);
      const chat = await thread(ctx.alice);
      await ctx.pool.db.execute(
        sql`insert into thread_connector_use (thread_id, connector_id) values (${chat.id}, ${connector.id})`,
      );
      setMode('block');
      expect((await classification(`threadId=${chat.id}`)).classes[0]).toMatchObject({
        reasons: ['connector'],
        connectorNames: ['Docs'],
        removable: false,
      });
      expect((await removeLabel(chat.id, student.id)).status).toBe(409);
      await ok(call('DELETE', `/api/admin/connectors/${connector.id}`));
      const after = (await classification(`threadId=${chat.id}`)).classes[0];
      expect(after).toMatchObject({
        reasons: ['kept'],
        origins: ['connector: Docs'],
        removable: false,
      });
      const refused = await removeLabel(chat.id, student.id);
      expect(refused.status).toBe(409);
      expect((await body(refused)).error.message).toContain('stays');
    });
  });

  describe('people label their own conversations and projects', () => {
    it('adds and removes a label on a conversation, audited by id and name', async () => {
      const student = await createClass('Student records');
      const chat = await thread(ctx.alice);
      const first = await labelThread(ctx.alice, chat.id, student.id);
      expect(first.status).toBe(201);
      expect((await body(first)).classes).toEqual([
        expect.objectContaining({ name: 'Student records', reasons: ['person'], removable: true }),
      ]);
      expect((await labelThread(ctx.alice, chat.id, student.id)).status).toBe(200);
      expect(await auditsOf('thread.data_class.add')).toHaveLength(1);
      const removed = await removeLabel(chat.id, student.id);
      expect(removed.status).toBe(200);
      expect((await body(removed)).classes).toEqual([]);
      expect((await auditsOf('thread.data_class.remove'))[0]?.metadata).toEqual({
        classId: student.id,
        name: 'Student records',
      });
      expect((await removeLabel(chat.id, student.id)).status).toBe(404);
    });

    it('a retired or unknown class cannot be added', async () => {
      const student = await createClass('Student records');
      await ok(call('POST', `/api/admin/data-classes/${student.id}/retire`));
      const chat = await thread(ctx.alice);
      expect((await labelThread(ctx.alice, chat.id, student.id)).status).toBe(422);
      expect((await labelThread(ctx.alice, chat.id, 'nope')).status).toBe(422);
      expect(
        (await call('POST', `/api/threads/${chat.id}/data-classes`, { user: ctx.alice, body: {} }))
          .status,
      ).toBe(422);
    });

    it('another person’s conversation or project is a 404, and reveals nothing', async () => {
      const student = await createClass('Student records');
      const project = await createProject(ctx.alice);
      await labelProject(ctx.alice, project.id, [student.id]);
      const chat = await projectThread(ctx.alice, project.id);
      setMode('block');
      for (const response of [
        await labelThread(ctx.bob, chat.id, student.id),
        await removeLabel(chat.id, student.id, ctx.bob),
        await call('GET', `/api/classification?threadId=${chat.id}`, { user: ctx.bob }),
        await call('GET', `/api/classification?projectId=${project.id}`, { user: ctx.bob }),
        await call('PUT', `/api/projects/${project.id}/data-classes`, {
          user: ctx.bob,
          body: { classIds: [] },
        }),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('Student');
      }
      // Still labelled: nothing Bob did changed it.
      expect((await classification(`threadId=${chat.id}`)).classes).toHaveLength(1);
    });

    it('a project’s labels reach its conversations; an administrator’s are locked', async () => {
      const student = await createClass('Student records');
      const health = await createClass('Health records');
      const project = await createProject(ctx.alice);
      const chat = await projectThread(ctx.alice, project.id);
      await labelProject(ctx.alice, project.id, [student.id]);
      setMode('warn');
      expect((await classification(`threadId=${chat.id}`)).classes[0]).toMatchObject({
        reasons: ['project'],
        removable: false,
      });
      // The thread cannot drop a project label.
      expect((await removeLabel(chat.id, student.id)).status).toBe(409);

      // An administrator labels the project: every label they set is locked.
      const set = await ok<{ classes: Array<{ name: string; locked: boolean }> }>(
        call('PUT', `/api/admin/projects/${project.id}/data-classes`, {
          body: { classIds: [student.id, health.id] },
        }),
      );
      expect(set.classes.map((entry) => [entry.name, entry.locked])).toEqual([
        ['Health records', true],
        ['Student records', true],
      ]);
      const listed = await ok<{ projects: Array<{ name: string; classes: unknown[] }> }>(
        call('GET', `/api/admin/users/${ctx.alice}/projects`),
      );
      expect(listed.projects).toEqual([
        expect.objectContaining({ name: 'Records', classes: expect.any(Array) }),
      ]);
      expect(listed.projects[0]?.classes).toHaveLength(2);

      // The owner may add but not remove a locked label.
      const refused = await call('PUT', `/api/projects/${project.id}/data-classes`, {
        user: ctx.alice,
        body: { classIds: [student.id] },
      });
      expect(refused.status).toBe(409);
      const kept = await call('PUT', `/api/projects/${project.id}/data-classes`, {
        user: ctx.alice,
        body: { classIds: [student.id, health.id] },
      });
      expect(kept.status).toBe(200);
      expect((await body(kept)).classes.every((entry: { locked: boolean }) => entry.locked)).toBe(
        true,
      );
      // An administrator may remove them.
      await ok(
        call('PUT', `/api/admin/projects/${project.id}/data-classes`, { body: { classIds: [] } }),
      );
      expect((await classification(`projectId=${project.id}`)).classes).toEqual([]);
      const audits = await auditsOf('project.data_classes.update');
      expect(audits.map((row) => (row.metadata as { by: string }).by)).toEqual([
        'owner',
        'admin',
        'owner',
        'admin',
      ]);
      expect(
        (await call('PUT', '/api/admin/projects/nope/data-classes', { body: { classIds: [] } }))
          .status,
      ).toBe(404);
      expect((await call('GET', '/api/admin/users/nope/projects')).status).toBe(404);
    });

    it('answers what a conversation carries and which models may take it, computed on the server', async () => {
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      const project = await createProject(ctx.alice);
      await labelProject(ctx.alice, project.id, [student.id]);
      const chat = await projectThread(ctx.alice, project.id);
      const statusOf = (body: Classification) =>
        Object.fromEntries(
          body.models.map((m) => [m.slug, [m.status, m.missing.map((x) => x.name)]]),
        );

      expect(await classification(`threadId=${chat.id}`)).toEqual({
        mode: 'off',
        classes: [],
        models: [],
      });
      setMode('block');
      const blockedBody = await classification(`threadId=${chat.id}`);
      expect(blockedBody.classes).toEqual([
        expect.objectContaining({ name: 'Student records', reasons: ['project'] }),
      ]);
      expect(statusOf(blockedBody)).toEqual({
        [APPROVED_MODEL]: ['ok', []],
        [UNAPPROVED_MODEL]: ['blocked', ['Student records']],
      });
      setMode('warn');
      expect(statusOf(await classification(`projectId=${project.id}`))[UNAPPROVED_MODEL]).toEqual([
        'warn',
        ['Student records'],
      ]);
      for (const query of ['', `threadId=${chat.id}&projectId=${project.id}`])
        expect(
          (await call('GET', `/api/classification?${query}`, { user: ctx.alice })).status,
        ).toBe(422);
      expect((await call('GET', '/api/classification?threadId=x', { user: null })).status).toBe(
        401,
      );
    });

    it('lists the classes that can still be added, none while off, and never a retired one', async () => {
      const student = await createClass('Student records');
      const health = await createClass('Health records');
      const names = async () =>
        (
          await ok<{ classes: Array<{ name: string }> }>(
            call('GET', '/api/data-classes', { user: ctx.alice }),
          )
        ).classes.map((entry) => entry.name);
      expect(await names()).toEqual([]);
      setMode('warn');
      expect(await names()).toEqual(['Health records', 'Student records']);
      await ok(call('POST', `/api/admin/data-classes/${health.id}/retire`));
      expect(await names()).toEqual(['Student records']);
      expect(student.id).toBeTruthy();
      expect((await call('GET', '/api/data-classes', { user: null })).status).toBe(401);
    });

    it('puts dataClasses on conversations in lists, only while classification is on', async () => {
      const student = await createClass('Student records');
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, student.id);
      const list = async () =>
        (
          await ok<{ threads: Array<{ id: string; dataClasses?: unknown }> }>(
            call('GET', '/api/threads', { user: ctx.alice }),
          )
        ).threads.find((entry) => entry.id === chat.id)!;
      expect(await list()).not.toHaveProperty('dataClasses');
      setMode('warn');
      expect((await list()).dataClasses).toEqual([
        { id: student.id, name: 'Student records', reasons: ['person'] },
      ]);
      const one = await ok<{ thread: { dataClasses: unknown[] } }>(
        call('GET', `/api/threads/${chat.id}`, { user: ctx.alice }),
      );
      expect(one.thread.dataClasses).toHaveLength(1);
    });
  });

  describe('who may do what', () => {
    const adminRoutes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/data-classes'],
      ['POST', '/api/admin/data-classes', { name: 'Nope' }],
      ['PATCH', '/api/admin/data-classes/x', { name: 'Nope' }],
      ['POST', '/api/admin/data-classes/x/retire'],
      ['DELETE', '/api/admin/data-classes/x'],
      ['PUT', '/api/admin/models/x/data-classes', { classIds: [] }],
      ['PUT', '/api/admin/connectors/x/data-classes', { classIds: [], reviewed: true }],
      ['GET', '/api/admin/classification'],
      ['PATCH', '/api/admin/classification', { mode: 'off' }],
      ['PUT', '/api/admin/projects/x/data-classes', { classIds: [] }],
      ['GET', '/api/admin/users/x/projects'],
    ];

    it('is closed to people who are not administrators, and to anonymous callers', async () => {
      for (const [method, path, body] of adminRoutes) {
        expect(
          (await call(method, path, { user: ctx.alice, body })).status,
          `${method} ${path}`,
        ).toBe(403);
        expect((await call(method, path, { user: null, body })).status, `${method} ${path}`).toBe(
          401,
        );
      }
      expect(await adminClasses()).toEqual([]);
    });

    it('lets an auditor read and nothing else', async () => {
      const student = await createClass('Student records');
      const asAuditor = (method: string, path: string, body?: unknown) =>
        call(method, path, { user: ctx.auditor, body });
      expect((await asAuditor('GET', '/api/admin/data-classes')).status).toBe(200);
      expect((await asAuditor('GET', '/api/admin/classification')).status).toBe(200);
      for (const [method, path, body] of adminRoutes.filter(([method]) => method !== 'GET'))
        expect((await asAuditor(method, path, body)).status, `${method} ${path}`).toBe(403);
      expect(await adminClasses()).toEqual([expect.objectContaining({ id: student.id })]);
    });
  });

  describe('share links', () => {
    async function sharedLabelled() {
      const student = await createClass('Student records');
      const chat = await thread(ctx.alice);
      const created = await ok<{ link: { slug: string; id: string; paused: boolean } }>(
        call('POST', `/api/share-links/threads/${chat.id}`, { user: ctx.alice, body: {} }),
        201,
      );
      await ctx.pool.db.execute(
        sql`insert into message (id, thread_id, user_id, role, position, parts, status)
            values ('m-share', ${chat.id}, ${ctx.alice}, 'user', 0, '[{"type":"text","text":"Visible"}]'::jsonb, 'complete')`,
      );
      return { student, chat, link: created.link };
    }
    const read = (slug: string) => ctx.app.request(`/api/share-links/${slug}`);

    it('pauses an existing link while the conversation carries a class, disclosing nothing, and resumes after', async () => {
      const { student, chat, link } = await sharedLabelled();
      setMode('block');
      expect((await read(link.slug)).status).toBe(200);
      await labelThread(ctx.alice, chat.id, student.id);
      const paused = await read(link.slug);
      expect(paused.status).toBe(404);
      expect(await paused.text()).not.toContain('Student');
      const listed = await ok<{ links: Array<{ paused: boolean; revokedAt: string | null }> }>(
        call('GET', `/api/share-links/threads/${chat.id}`, { user: ctx.alice }),
      );
      expect(listed.links[0]).toMatchObject({ paused: true, revokedAt: null });
      await removeLabel(chat.id, student.id);
      expect((await read(link.slug)).status).toBe(200);
    });

    it('warn creates the link with a notice and an audit entry, and serves an existing one', async () => {
      const student = await createClass('Student records');
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, student.id);
      setMode('warn');
      const created = await ok<{ link: { slug: string }; notice?: string }>(
        call('POST', `/api/share-links/threads/${chat.id}`, { user: ctx.alice, body: {} }),
        201,
      );
      expect(created.notice).toContain('Student records');
      expect((await auditsOf('classification.warn'))[0]?.metadata).toMatchObject({
        point: 'share',
        destination: 'share',
      });
      expect(
        (await body(await call('GET', `/api/share-links/threads/${chat.id}`, { user: ctx.alice })))
          .links[0]?.paused,
      ).toBe(false);
    });

    it('does not let a stranger learn a class from a refusal', async () => {
      const student = await createClass('Student records');
      const chat = await thread(ctx.alice);
      await labelThread(ctx.alice, chat.id, student.id);
      setMode('block');
      const response = await call('POST', `/api/share-links/threads/${chat.id}`, {
        user: ctx.bob,
        body: {},
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Student');
    });
  });

  describe('audit and metrics', () => {
    it('records a block with ids, names at the time, the point and the model, and never the content', async () => {
      const { classificationDecisions, renderMetrics, resetMetrics } = await import(
        '../../services/observability/metrics.js'
      );
      resetMetrics();
      const student = await createClass('Student records');
      await approve(APPROVED_MODEL, [student.id]);
      const project = await createProject(ctx.alice, 'Case notes project');
      await labelProject(ctx.alice, project.id, [student.id]);
      const chat = await projectThread(ctx.alice, project.id);
      setMode('block');
      script(textStep('Fine.'));
      const secret = 'Marks for J. Smith are 41 and 38';
      await blocked(await send(ctx.alice, chat.id, secret, { modelSlug: UNAPPROVED_MODEL }));
      await accepted(
        await send(ctx.alice, chat.id, secret, { modelSlug: APPROVED_MODEL }),
        chat.id,
      );

      const [event] = await auditsOf('classification.block');
      expect(event).toMatchObject({
        actorUserId: ctx.alice,
        targetType: 'thread',
        targetId: chat.id,
      });
      expect(event?.actorEmail).toBeTruthy();
      expect(event?.metadata).toEqual({
        point: 'send',
        mode: 'block',
        destination: 'model',
        modelSlug: UNAPPROVED_MODEL,
        classes: [{ id: student.id, name: 'Student records' }],
        missing: [{ id: student.id, name: 'Student records' }],
      });
      const everything = JSON.stringify(await ctx.pool.db.execute(sql`select * from audit_log`));
      expect(everything).not.toContain('Marks for J. Smith');
      expect(everything).not.toContain('Case notes');
      // An allowed decision is counted, not audited.
      expect(await auditsOf('classification.warn')).toEqual([]);

      expect(classificationDecisions.get({ point: 'send', outcome: 'blocked' })).toBe(1);
      expect(classificationDecisions.get({ point: 'send', outcome: 'allowed' })).toBe(1);
      const body = await renderMetrics();
      expect(body).toContain(
        'oci_classification_decisions_total{point="send",outcome="blocked"} 1',
      );
      expect(body).not.toContain('Student');
    });

    it('counts nothing for a conversation that carries no class', async () => {
      const { classificationDecisions, resetMetrics } = await import(
        '../../services/observability/metrics.js'
      );
      resetMetrics();
      setMode('block');
      const chat = await thread(ctx.alice);
      script(textStep('Fine.'));
      await accepted(await send(ctx.alice, chat.id, 'Hello'), chat.id);
      expect(classificationDecisions.get({ point: 'send', outcome: 'allowed' })).toBe(0);
      expect(classificationDecisions.get({ point: 'send', outcome: 'blocked' })).toBe(0);
    });
  });

  describe('mode off is v0.13', () => {
    it('reads none of the classification tables to send, list or serve a labelled conversation', async () => {
      const student = await createClass('Student records');
      const project = await createProject(ctx.alice);
      await labelProject(ctx.alice, project.id, [student.id]);
      const chat = await projectThread(ctx.alice, project.id);
      await labelThread(ctx.alice, chat.id, student.id);
      script(textStep('Fine.'));
      const recording = recordStatements(ctx.pool);
      try {
        // The unapproved model: with the feature on this would be refused.
        await accepted(
          await send(ctx.alice, chat.id, 'Hello', { modelSlug: UNAPPROVED_MODEL }),
          chat.id,
        );
        await ok(call('GET', '/api/threads', { user: ctx.alice }));
        await ok(call('GET', `/api/threads/${chat.id}`, { user: ctx.alice }));
        await ok(call('GET', `/api/classification?threadId=${chat.id}`, { user: ctx.alice }));
        await ok(call('GET', '/api/data-classes', { user: ctx.alice }));
      } finally {
        recording.stop();
      }
      const touched = recording.statements.filter((text) => TOUCHES_CLASSIFICATION.test(text));
      expect(JSON.stringify(touched).slice(0, 900)).toBe('[]');
    });
  });
});
