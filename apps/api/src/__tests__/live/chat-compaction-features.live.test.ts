import { createDatabase, eq, schema, sql } from '@oci/db';
import { strFromU8, unzipSync } from 'fflate';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  held,
  promptText,
  scriptFor,
  summary,
  systemOf,
  textStep,
  toolStep,
} from '../../../test/chat-compaction.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * Conversation compaction through real PostgreSQL, the real chat and thread
 * routes, turn preparation, the reply stream, persistence, usage accounting
 * and the background queue (in-process kick and job-runner pass), with a
 * scripted model in place of a provider: replies stream (doStream) and
 * summaries are generated (doGenerate). Summaries are only ever made in the
 * background; a reply never waits for one.
 *
 * This file: compaction with forks, edits, exports, shares and approvals.
 * The shared model script and helpers are in test/chat-compaction.fixtures.ts;
 * the other chat-compaction-*.live.test.ts files cover the rest.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  model: null as unknown,
  capabilities: [] as string[],
  contextWindow: 16_000,
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
    contextWindow: state.contextWindow,
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
};
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => {
    const value = state.settings.get(key);
    // A setting that cannot be read.
    if (value instanceof Error) throw value;
    return value ?? defaults[key] ?? {};
  },
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getReserveAmounts: async () => ({ costMicros: 0, tokens: 50 }),
}));
vi.mock('../../services/system-prompt.js', () => ({
  buildSystemPrompt: async () => 'BASE_SYSTEM_PROMPT',
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
// A write tool exists only in this test, for the approval continuation.
vi.mock('../../services/tools/catalog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/tools/catalog.js')>();
  return {
    registeredTools: async () => [
      ...(await original.registeredTools()),
      {
        id: 'send_note',
        label: 'Send note',
        description: 'Sends a note to someone.',
        kind: 'write',
        source: 'builtin',
        inputSchema: z.object({ to: z.string() }),
        available: () => true,
        execute: async () => ({ sent: true }),
      },
    ],
  };
});

const available = await livePostgresAvailable();
const script = scriptFor(state);

describe.skipIf(!available)('live conversation compaction', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let owner: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('compaction');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    app = await compactionApp(state.organizationId, owner);
  });
  beforeEach(() => {
    state.settings.clear();
    state.capabilities = [];
    state.contextWindow = 16_000;
  });
  afterEach(async () => {
    const { compactionQueueSettled } = await import('../../services/chat/compaction-queue.js');
    await compactionQueueSettled();
    await pool.db.execute(sql`update message set status = 'complete' where status = 'streaming'`);
    await pool.db.execute(sql`delete from quota_policy`);
    await pool.db.execute(sql`delete from conversation_compaction_job`);
    await pool.db.execute(sql`delete from conversation_compaction_failure`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const {
    thread,
    compactions,
    seedTurns,
    settled,
    turn,
    jobs,
    background,
    queued,
    compact,
    turnsIn,
  } = compactionHelpers({
    get pool() {
      return pool;
    },
    get app() {
      return app;
    },
    get owner() {
      return owner;
    },
    get organizationId() {
      return state.organizationId;
    },
  });

  describe('with other features', () => {
    async function compacted() {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      script([], [summary('FORK-SUMMARY')]);
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      // The cut is at turn 3's question.
      const [record] = await compactions(chat.id);
      expect(record!.firstKeptMessageId).toBe(seeded[4]!.id);
      return { chat, seeded, record: record! };
    }
    async function copiedCompaction(threadId: string) {
      const [record] = await compactions(threadId);
      if (!record) return null;
      const [kept] = await pool.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.id, record.firstKeptMessageId));
      return { record, kept: kept! };
    }

    it('forks and edits copy the compaction only when the cut lies within the copied messages', async () => {
      const { chat, seeded } = await compacted();
      const forkAt = async (messageId: string) => {
        const response = await app.request(`/api/threads/${chat.id}/forks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { thread: { id: string } }).thread.id;
      };
      const after = await copiedCompaction(await forkAt(seeded[7]!.id));
      expect(after?.record).toMatchObject({ summary: 'FORK-SUMMARY', tokensIn: null });
      expect(after?.kept).toMatchObject({ parentMessageId: seeded[4]!.id, role: 'user' });
      expect(after?.kept.threadId).not.toBe(chat.id);
      expect(await copiedCompaction(await forkAt(seeded[4]!.id))).not.toBeNull();
      expect(await copiedCompaction(await forkAt(seeded[3]!.id))).toBeNull();

      const editAt = async (messageId: string) => {
        const response = await app.request(`/api/threads/${chat.id}/branches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId, text: 'Edited' }),
        });
        expect(response.status).toBe(201);
        return ((await response.json()) as { thread: { id: string } }).thread.id;
      };
      const edited = await copiedCompaction(await editAt(seeded[6]!.id));
      expect(edited?.kept.parentMessageId).toBe(seeded[4]!.id);
      expect(await copiedCompaction(await editAt(seeded[4]!.id))).toBeNull();

      const forked = await forkAt(seeded[7]!.id);
      const model = script([textStep('From the fork')]);
      await turn(forked, 'CONTINUE');
      expect(systemOf(model.doStreamCalls[0]!.prompt)).toContain('FORK-SUMMARY');
      expect(turnsIn(promptText(model.doStreamCalls[0]!.prompt))).toEqual([3, 4]);
    });

    it('keeps the full history in exports and share links; the JSON export includes the summary', async () => {
      const { chat, seeded, record } = await compacted();
      const { exportThreadMarkdown } = await import('../../services/export.js');
      const markdown = await exportThreadMarkdown(chat.id, owner);
      expect(markdown).toContain('TURN-1-QUESTION');
      expect(markdown).not.toContain('FORK-SUMMARY');

      const { exportArchive } = await import('../../services/portability/export-archive.js');
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportArchive({ id: owner })) chunks.push(chunk);
      const files = unzipSync(Buffer.concat(chunks));
      const conversations = Object.entries(files)
        .filter(([name]) => name.startsWith('conversations/') && name.endsWith('.json'))
        .map(([, bytes]) => JSON.parse(strFromU8(bytes)) as Record<string, unknown>);
      const exported = conversations.find(
        (conversation) => (conversation.thread as { id: string }).id === chat.id,
      ) as { messages: Array<{ id: string }>; compactions: unknown[] };
      expect(exported.messages.map((message) => message.id)).toEqual(seeded.map((row) => row.id));
      expect(exported.compactions).toEqual([
        expect.objectContaining({
          id: record.id,
          summary: 'FORK-SUMMARY',
          firstKeptMessageId: seeded[4]!.id,
          reason: 'manual',
        }),
      ]);

      const { createShareLink, getPublicShare } = await import('../../services/share-links.js');
      const link = await createShareLink(chat.id, owner, {});
      const shared = await getPublicShare(link.slug);
      expect(shared.messages.map((message) => message.id)).toEqual(seeded.map((row) => row.id));
      expect(JSON.stringify(shared)).not.toContain('FORK-SUMMARY');
    });

    it('goes with its conversation when the conversation is deleted', async () => {
      const { chat } = await compacted();
      await queued(chat.id);
      await pool.db.delete(schema.thread).where(eq(schema.thread.id, chat.id));
      expect(await compactions(chat.id)).toHaveLength(0);
      expect(await jobs(chat.id)).toHaveLength(0);
    });

    it('rebuilds a continued reply’s input with fewer turns after an overflow', async () => {
      state.capabilities = ['tool_calling'];
      state.settings.set('roleTools', { roles: { user: { send_note: true } } });
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      script([toolStep('w1', 'send_note', { to: 'Ada' })]);
      const { reply } = await turn(chat.id, 'Send Ada a note');
      const pending = reply.parts.find((part) => part.state === 'approval-requested') as {
        approval: { id: string };
      };
      const { setupApprovalContinuation } = await import('../../services/chat/approvals.js');
      const { releaseRunHandles } = await import('../../services/chat/run-cleanup.js');
      const model = script([], [summary('unused')]);
      const { turn: continued, run } = await setupApprovalContinuation(
        { id: owner, name: 'Test', role: 'user' },
        chat.id,
        { messageId: reply.id, responses: [{ approvalId: pending.approval.id, approved: true }] },
      );
      try {
        expect(turnsIn(JSON.stringify(continued.uiMessages))).toEqual([1, 2, 3, 4]);
        const recovered = await continued.recoverOverflow!();
        expect(recovered?.contextLimited).toBe(true);
        expect(recovered?.system).not.toContain('<conversation-summary>');
        // The reply being continued is still the last message, after the kept turns.
        expect(recovered?.uiMessages.at(-1)?.id).toBe(reply.id);
        expect(turnsIn(JSON.stringify(recovered?.uiMessages))).toEqual([3, 4]);
        expect(model.doGenerateCalls).toHaveLength(0);
      } finally {
        await releaseRunHandles(run, true);
      }
    });

    it('approving while a summary is being made goes ahead; the continued reply can queue one too', async () => {
      state.capabilities = ['tool_calling'];
      state.settings.set('roleTools', { roles: { user: { send_note: true } } });
      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: false });
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([toolStep('w1', 'send_note', { to: 'Ada' })]);
      const { reply } = await turn(chat.id, 'Send Ada a note');
      const pending = reply.parts.find((part) => part.state === 'approval-requested') as
        | { approval: { id: string } }
        | undefined;
      expect(pending).toBeDefined();
      expect(await jobs(chat.id)).toHaveLength(0);

      state.settings.set('chat', { defaultSystemPrompt: null, autoCompact: true });
      const making = held('APPROVAL-SUMMARY');
      const model = script([textStep('Sent.')], [making.step, summary('SPARE')]);
      expect((await compact(chat.id)).status).toBe(202);
      await making.running;
      const response = await app.request(`/api/chat/${chat.id}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: reply.id,
          responses: [{ approvalId: pending!.approval.id, approved: true }],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      const stored = await settled(chat.id);
      const continuedReply = stored.find((row) => row.id === reply.id)!;
      expect(continuedReply.status).toBe('complete');
      // It went ahead without the summary, with the oldest turns left out.
      const continued = model.doStreamCalls[0]!.prompt;
      expect(systemOf(continued)).not.toContain('<conversation-summary>');
      expect(turnsIn(promptText(continued))).not.toContain(1);
      expect(promptText(continued)).toContain('Send Ada a note');

      making.release();
      await background();
      const [record] = await compactions(chat.id);
      expect(record).toMatchObject({ reason: 'manual', summary: 'APPROVAL-SUMMARY' });
      // The reply being continued and its prompt are never summarised.
      expect(promptText(model.doGenerateCalls[0]!.prompt)).not.toContain('Send Ada a note');
    });
  });
});
