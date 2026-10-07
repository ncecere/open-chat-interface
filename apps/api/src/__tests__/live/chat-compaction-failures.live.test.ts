import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  promptText,
  scriptFor,
  summary,
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
 * This file: reporting failed summaries.
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
  let stranger: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('compaction');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, state.organizationId);
    stranger = await seedUser(pool.db, state.organizationId);
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

  const { thread, seedTurns, jobs, background, processQueue, compactionStatus, queued, compact } =
    compactionHelpers({
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

  describe('failed summaries are reported (v0.10)', () => {
    async function spendAllowance(person: string) {
      const [policy] = await pool.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId: state.organizationId,
          name: 'Tiny',
          metric: 'tokens',
          limitValue: 1,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
        })
        .returning();
      await pool.db.insert(schema.quotaPolicyRole).values({ policyId: policy!.id, role: 'user' });
      await pool.db.insert(schema.usageEvent).values({
        organizationId: state.organizationId,
        userId: person,
        modelSlug: 'test-model',
        tokensIn: 10,
        tokensOut: 10,
      });
    }
    function dismiss(threadId: string, user = owner) {
      return app.request(`/api/threads/${threadId}/compaction/failure`, {
        method: 'DELETE',
        headers: { 'x-test-user': user },
      });
    }

    it('reports a model error with the instructions; Retry clears it and succeeds', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script([], [new Error('provider down'), summary('ON-RETRY')]);
      expect((await compact(chat.id, { instructions: 'keep the figures' })).status).toBe(202);
      await background();
      expect(model.doGenerateCalls).toHaveLength(1);
      const failed = await compactionStatus(chat.id);
      expect(failed).toMatchObject({
        compaction: null,
        pending: false,
        failure: { reason: 'model_error', instructions: 'keep the figures' },
      });
      expect(Date.parse(failed.failure!.failedAt)).toBeGreaterThan(Date.now() - 60_000);
      // The usual retry is still scheduled; asking again runs it now.
      expect(await jobs(chat.id)).toMatchObject([{ status: 'pending', reason: 'manual' }]);
      const again = await compact(chat.id, { instructions: 'keep the figures' });
      expect(again.status).toBe(202);
      expect(await again.json()).toMatchObject({ pending: true, failure: null });
      await background();
      expect(await compactionStatus(chat.id)).toMatchObject({
        compaction: { reason: 'manual' },
        pending: false,
        failure: null,
      });
      expect(promptText(model.doGenerateCalls[1]!.prompt)).toContain('focus on: keep the figures');
    });

    it('never reports an automatic summary', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([], [new Error('provider down')]);
      const { requestCompaction } = await import('../../services/chat/compaction-queue.js');
      await requestCompaction({
        threadId: chat.id,
        userId: owner,
        modelSlug: 'test-model',
        reason: 'automatic',
      });
      await background();
      expect(await jobs(chat.id)).toMatchObject([{ attempts: 1 }]);
      expect((await compactionStatus(chat.id)).failure).toBeNull();
    });

    it('reports a summary that took too long, and one with nothing left to summarise', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      script(
        [],
        [
          () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
          },
        ],
      );
      await compact(chat.id);
      await background();
      expect((await compactionStatus(chat.id)).failure).toMatchObject({
        reason: 'timeout',
        instructions: null,
      });

      // By the time it ran, there was nothing to summarise (one turn).
      const short = await thread();
      await seedTurns(short.id, 1, 1);
      await queued(short.id, { instructions: 'names' });
      expect(await processQueue()).toBe(1);
      expect(await jobs(short.id)).toHaveLength(0);
      expect((await compactionStatus(short.id)).failure).toMatchObject({
        reason: 'nothing_to_summarise',
        instructions: 'names',
      });
    });

    it('tells the person at once when their allowance is spent, instead of waiting a day', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const chat = await thread(person);
      await seedTurns(chat.id, 1, 4, person);
      await spendAllowance(person);
      const model = script([], [summary('NEVER')]);
      await queued(chat.id, {}, person);
      expect(await processQueue()).toBe(1);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect((await compactionStatus(chat.id, person)).failure).toMatchObject({
        reason: 'allowance',
      });
      // A background check is not a refusal the person made.
      expect(
        await pool.db
          .select()
          .from(schema.quotaDenial)
          .where(eq(schema.quotaDenial.userId, person)),
      ).toHaveLength(0);
    });

    it('is dismissed by its owner only, and cleared by a later automatic success', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 13);
      script([], [new Error('down'), summary('AUTOMATIC-LATER')]);
      await compact(chat.id);
      await background();
      expect((await compactionStatus(chat.id)).failure).not.toBeNull();
      expect((await dismiss(chat.id, stranger)).status).toBe(404);
      expect((await compactionStatus(chat.id)).failure).not.toBeNull();
      const dismissed = await dismiss(chat.id);
      expect(dismissed.status).toBe(200);
      expect(await dismissed.json()).toMatchObject({ failure: null });
      expect((await dismiss(chat.id)).status).toBe(200);

      // Failed again, then an automatic summary of the same thread succeeds.
      await pool.db.execute(sql`delete from conversation_compaction_job`);
      script([], [new Error('down again'), summary('AUTOMATIC-LATER')]);
      await compact(chat.id);
      await background();
      expect((await compactionStatus(chat.id)).failure).toMatchObject({ reason: 'model_error' });
      await pool.db.execute(sql`delete from conversation_compaction_job`);
      const { requestCompaction } = await import('../../services/chat/compaction-queue.js');
      await requestCompaction({
        threadId: chat.id,
        userId: owner,
        modelSlug: 'test-model',
        reason: 'automatic',
      });
      await background();
      expect(await compactionStatus(chat.id)).toMatchObject({
        compaction: { reason: 'automatic' },
        failure: null,
      });
    });

    it('classifies errors: a timeout anywhere in the chain, anything else a model error', async () => {
      const { failureCategory } = await import('../../services/chat/compaction-queue.js');
      expect(failureCategory(new DOMException('x', 'TimeoutError'))).toBe('timeout');
      expect(failureCategory(new DOMException('x', 'AbortError'))).toBe('timeout');
      expect(failureCategory(new Error('Request timed out'))).toBe('timeout');
      expect(
        failureCategory(new Error('Retry failed', { cause: new Error('fetch timeout') })),
      ).toBe('timeout');
      expect(
        failureCategory(
          Object.assign(new Error('retries'), {
            errors: [new Error('a'), new DOMException('b', 'TimeoutError')],
          }),
        ),
      ).toBe('timeout');
      expect(failureCategory(new Error('rate limited'))).toBe('model_error');
      expect(failureCategory('a string')).toBe('model_error');
      expect(failureCategory(null)).toBe('model_error');
    });
  });
});
