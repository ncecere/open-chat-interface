import { schema, sql } from '@oci/db';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVED_MODEL,
  type ClassificationState,
  useClassificationSuite,
} from '../../../test/classification.fixtures.js';
import {
  offered,
  textStep,
  toolParts,
  toolStep,
  usage,
} from '../../../test/connectors.fixtures.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * Data classification (#395) for what happens after a first reply: continuing a
 * reply once its tool calls are answered (c), summarising earlier turns by hand
 * or in the background (e), and the memory tools (h). The scripted model counts
 * provider calls and summaries; the MCP server counts `tools/call`.
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
    memory: true,
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

const summary = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: usage(300, 40),
  warnings: [],
});

describe.skipIf(!available)(
  'live data classification: continuing, summarising, remembering',
  () => {
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
      send,
      accepted,
      blocked,
      providerCalls,
      docsConnector,
      enable,
      allow,
      audits,
      auditsOf,
      thread,
      rows,
    } = suite;

    /** A model that streams replies and writes summaries, counting both. */
    function scriptWithSummaries(replies: unknown[], summaries: unknown[] = []) {
      let reply = 0;
      let written = 0;
      const model = new MockLanguageModelV4({
        doStream: (async () => {
          const step = replies[reply++];
          if (!step) throw new Error('The scripted model has no more replies');
          return typeof step === 'function' ? await step() : step;
        }) as never,
        doGenerate: (async () => {
          const next = summaries[written++];
          if (!next) throw new Error('The scripted model has no more summaries');
          return next;
        }) as never,
      });
      state.model = model;
      return model;
    }
    const answer = (chatId: string, messageId: string, approvalId: string, approved: boolean) =>
      ctx.app.request(`/api/chat/${chatId}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': ctx.alice },
        body: JSON.stringify({ messageId, responses: [{ approvalId, approved }] }),
      });
    const removeLabel = (chatId: string, classId: string) =>
      call('DELETE', `/api/threads/${chatId}/data-classes/${classId}`, { user: ctx.alice });
    const compact = (chatId: string, modelSlug: string) =>
      call('POST', `/api/threads/${chatId}/compact`, { user: ctx.alice, body: { modelSlug } });

    afterEach(async () => {
      await ctx.pool.db.execute(sql`delete from conversation_compaction_job`);
      await ctx.pool.db.execute(sql`delete from conversation_compaction_failure`);
      await ctx.pool.db.execute(sql`delete from user_memory`);
      await ctx.pool.db.execute(sql`delete from user_preference`);
    });

    describe('c. approval continuation', () => {
      async function pendingWrite() {
        const connector = await docsConnector({ reviewed: true });
        await enable(connector, 'create_page');
        await allow(['mcp__docs__create_page']);
        await carry(connector, []);
        const chat = await thread(ctx.alice);
        script(toolStep([['w1', 'mcp__docs__create_page', { title: 'Plan' }]]), textStep('Done.'));
        const stored = await accepted(
          await send(ctx.alice, chat.id, 'Create a page', { modelSlug: APPROVED_MODEL }),
          chat.id,
        );
        const reply = stored.at(-1)!;
        const pending = toolParts(reply.parts).find((part) => part.state === 'approval-requested');
        return {
          connector,
          chat,
          reply,
          approvalId: (pending!.approval as { id: string }).id,
        };
      }

      it('refuses to continue when a label arrived the model is not approved for, leaves the reply waiting, and continues once it is removed', async () => {
        const student = await createClass('Student records');
        const health = await createClass('Health records');
        await approve(APPROVED_MODEL, [student.id]);
        setMode('block');
        const { chat, reply, approvalId } = await pendingWrite();
        expect(providerCalls()).toBe(1);
        expect((await labelThread(ctx.alice, chat.id, health.id)).status).toBe(201);

        const refused = await answer(chat.id, reply.id, approvalId, true);
        const error = await blocked(refused);
        expect(error.details).toMatchObject({
          point: 'approval',
          missing: [{ name: 'Health records' }],
        });
        expect(providerCalls()).toBe(1);
        expect(ctx.mcp.calls).toHaveLength(0);
        const waiting = (await rows(chat.id)).find((row) => row.id === reply.id)!;
        expect(waiting.status).toBe('complete');
        expect(toolParts(waiting.parts).some((part) => part.state === 'approval-requested')).toBe(
          true,
        );

        expect((await removeLabel(chat.id, health.id)).status).toBe(200);
        const answered = await answer(chat.id, reply.id, approvalId, true);
        expect(answered.status, await answered.clone().text()).toBe(200);
        await answered.text();
        await suite.settled(chat.id);
        expect(ctx.mcp.calls).toHaveLength(1);
        expect(providerCalls()).toBe(2);
      });

      it('never runs an approved write tool whose connector now carries a class the model is not approved for', async () => {
        const student = await createClass('Student records');
        const health = await createClass('Health records');
        await approve(APPROVED_MODEL, [student.id]);
        setMode('block');
        const { connector, chat, reply, approvalId } = await pendingWrite();
        // The administrator classifies the connector after the call was requested.
        await carry(connector, [health.id]);

        const answered = await answer(chat.id, reply.id, approvalId, true);
        await answered.text();
        await suite.settled(chat.id);
        expect(ctx.mcp.calls).toHaveLength(0);
        expect(
          (await audits('tool.call')).some(
            (row) => (row.metadata as { outcome: string }).outcome === 'ok',
          ),
        ).toBe(false);
      });
    });

    describe('e. compaction', () => {
      async function twoTurns() {
        const student = await createClass('Student records');
        const health = await createClass('Health records');
        await approve(APPROVED_MODEL, [student.id]);
        const chat = await thread(ctx.alice);
        const model = scriptWithSummaries(
          [textStep('First answer.'), textStep('Second answer.')],
          [summary('A summary.')],
        );
        for (const text of ['First question', 'Second question'])
          await accepted(
            await send(ctx.alice, chat.id, text, { modelSlug: APPROVED_MODEL }),
            chat.id,
          );
        return { chat, model, student, health };
      }

      it('refuses a manual request for a model not approved, with no summary and nothing queued, then summarises once the label is gone', async () => {
        const { chat, model, health } = await twoTurns();
        setMode('block');
        expect((await labelThread(ctx.alice, chat.id, health.id)).status).toBe(201);

        const refused = await compact(chat.id, APPROVED_MODEL);
        const error = await blocked(refused);
        expect(error.details).toMatchObject({ point: 'compaction' });
        expect(model.doGenerateCalls).toHaveLength(0);
        expect(await ctx.pool.db.select().from(schema.conversationCompactionJob)).toHaveLength(0);

        await removeLabel(chat.id, health.id);
        const accepted202 = await compact(chat.id, APPROVED_MODEL);
        expect(accepted202.status, await accepted202.clone().text()).toBe(202);
        const { compactionQueueSettled } = await import('../../services/chat/compaction-queue.js');
        await compactionQueueSettled();
        expect(model.doGenerateCalls).toHaveLength(1);
      });

      it('ends an automatic request quietly: no summary, no failure shown, no retry, audited', async () => {
        const { chat, model, health } = await twoTurns();
        setMode('block');
        await labelThread(ctx.alice, chat.id, health.id);
        const { requestCompaction, processCompactionQueue, compactionQueueSettled } = await import(
          '../../services/chat/compaction-queue.js'
        );
        await requestCompaction({
          threadId: chat.id,
          userId: ctx.alice,
          modelSlug: APPROVED_MODEL,
          reason: 'automatic',
        });
        await processCompactionQueue();
        expect(model.doGenerateCalls).toHaveLength(0);
        expect(await ctx.pool.db.select().from(schema.conversationCompactionJob)).toHaveLength(0);
        expect(await ctx.pool.db.select().from(schema.conversationCompactionFailure)).toHaveLength(
          0,
        );
        const blockedEvents = await auditsOf('classification.block');
        expect(blockedEvents).toHaveLength(1);
        expect(blockedEvents[0]?.metadata).toMatchObject({
          point: 'compaction',
          destination: 'model',
        });
      });

      it('warn summarises as before and audits what block would have refused', async () => {
        const { chat, model, health } = await twoTurns();
        setMode('warn');
        await labelThread(ctx.alice, chat.id, health.id);
        const response = await compact(chat.id, APPROVED_MODEL);
        expect(response.status).toBe(202);
        const { compactionQueueSettled } = await import('../../services/chat/compaction-queue.js');
        await compactionQueueSettled();
        expect(model.doGenerateCalls).toHaveLength(1);
        expect((await auditsOf('classification.warn')).length).toBeGreaterThan(0);
      });
    });

    describe('h. memory', () => {
      async function optedIn() {
        await ctx.pool.db
          .insert(schema.userPreference)
          .values({ userId: ctx.alice, memoryEnabled: true });
      }
      const remembers = () =>
        toolStep([['m1', 'remember', { content: 'The grades are in the blue folder' }]]);
      const notes = () => ctx.pool.db.select().from(schema.userMemory);

      it('offers remember in an unlabelled conversation, and the note is written', async () => {
        await optedIn();
        setMode('block');
        const chat = await thread(ctx.alice);
        const model = script(remembers(), textStep('Noted.'));
        await accepted(
          await send(ctx.alice, chat.id, 'Remember this', { modelSlug: APPROVED_MODEL }),
          chat.id,
        );
        expect(offered(model)).toEqual(expect.arrayContaining(['remember', 'forget']));
        expect(await notes()).toHaveLength(1);
      });

      for (const mode of ['warn', 'block'] as const)
        it(`does not offer remember in a labelled conversation in ${mode}; forget stays`, async () => {
          await optedIn();
          const student = await createClass('Student records');
          await approve(APPROVED_MODEL, [student.id]);
          setMode(mode);
          const chat = await thread(ctx.alice);
          await labelThread(ctx.alice, chat.id, student.id);
          const model = script(textStep('Nothing saved.'));
          await accepted(
            await send(ctx.alice, chat.id, 'Remember this', { modelSlug: APPROVED_MODEL }),
            chat.id,
          );
          expect(offered(model).filter((name) => name === 'remember')).toEqual([]);
          expect(offered(model)).toContain('forget');
          expect(await notes()).toHaveLength(0);
        });

      it('refuses a remember call when the label arrived after the tool was offered', async () => {
        await optedIn();
        const student = await createClass('Student records');
        await approve(APPROVED_MODEL, [student.id]);
        setMode('block');
        const chat = await thread(ctx.alice);
        script(async () => {
          expect((await labelThread(ctx.alice, chat.id, student.id)).status).toBe(201);
          return remembers();
        }, textStep('Understood.'));
        const stored = await accepted(
          await send(ctx.alice, chat.id, 'Remember this', { modelSlug: APPROVED_MODEL }),
          chat.id,
        );
        expect(await notes()).toHaveLength(0);
        const part = toolParts(stored.at(-1)!.parts).find((entry) => entry.toolCallId === 'm1');
        expect(part).toMatchObject({ state: 'output-error' });
        expect((await auditsOf('classification.block'))[0]?.metadata).toMatchObject({
          point: 'tool',
          destination: 'memory',
          toolId: 'remember',
        });
      });

      it('a project label counts as well', async () => {
        await optedIn();
        const student = await createClass('Student records');
        await approve(APPROVED_MODEL, [student.id]);
        setMode('block');
        const project = await createProject(ctx.alice);
        await labelProject(ctx.alice, project.id, [student.id]);
        const chat = await suite.projectThread(ctx.alice, project.id);
        const model = script(textStep('Nothing saved.'));
        await accepted(
          await send(ctx.alice, chat.id, 'Remember this', { modelSlug: APPROVED_MODEL }),
          chat.id,
        );
        expect(offered(model)).not.toContain('remember');
      });
    });
  },
);
