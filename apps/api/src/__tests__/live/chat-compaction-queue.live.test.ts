import { createDatabase, eq, schema, sql } from '@oci/db';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  compactionApp,
  compactionHelpers,
  held,
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
 * This file: the compaction queue.
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
    jobs,
    background,
    processQueue,
    compactionStatus,
    queued,
    compact,
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

  describe('the queue', () => {
    it('is picked up by the job runner after a restart, including a claim whose lease ran out', async () => {
      const { lifecycleJobs, COMPACTION_JOB } = await import('../../services/jobs/index.js');
      const job = lifecycleJobs().find((candidate) => candidate.name === COMPACTION_JOB)!;
      expect(job.intervalMs).toBeLessThanOrEqual(60_000);

      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const other = await thread();
      await seedTurns(other.id, 1, 4);
      const model = script([], [summary('AFTER-RESTART'), summary('TAKEN-OVER')]);
      await queued(chat.id);
      // A replica stopped while summarising: its lease ran out.
      await queued(other.id, {
        status: 'running',
        claimId: 'stopped-replica',
        leaseUntil: new Date(Date.now() - 1000),
        attempts: 1,
      });
      expect(await job.run()).toBe(2);
      expect(model.doGenerateCalls).toHaveLength(2);
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'manual',
        firstKeptMessageId: seeded[4]!.id,
      });
      expect(await compactions(other.id)).toHaveLength(1);
      expect(await jobs(chat.id)).toHaveLength(0);
      expect(await jobs(other.id)).toHaveLength(0);
    });

    it('lets one worker at a time summarise a conversation', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      const model = script(
        [],
        [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return summary('ONCE');
          },
          summary('TWICE'),
        ],
      );
      await queued(chat.id);
      // Two workers (two replicas' passes) at once: one claims, one finds nothing.
      const handled = await Promise.all([processQueue(), processQueue()]);
      expect(handled.sort()).toEqual([0, 1]);
      expect(model.doGenerateCalls).toHaveLength(1);
      expect((await compactions(chat.id)).map((record) => record.summary)).toEqual(['ONCE']);

      // A claim whose lease is still running is not taken over.
      await queued(chat.id, {
        status: 'running',
        claimId: 'live-replica',
        leaseUntil: new Date(Date.now() + 60_000),
      });
      expect(await processQueue()).toBe(0);
      expect(await compactionStatus(chat.id)).toMatchObject({ pending: true });
    });

    it('skips while the person’s allowance is spent and tries again later', async () => {
      const person = await seedUser(pool.db, state.organizationId);
      const chat = await thread(person);
      await seedTurns(chat.id, 1, 13, person);
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
      const model = script([], [summary('WHEN-ALLOWED')]);
      const { requestCompaction } = await import('../../services/chat/compaction-queue.js');
      await requestCompaction({
        threadId: chat.id,
        userId: person,
        modelSlug: 'test-model',
        reason: 'automatic',
      });
      await background();
      expect(model.doGenerateCalls).toHaveLength(0);
      const [job] = await jobs(chat.id);
      expect(job).toMatchObject({ status: 'pending', attempts: 0 });
      expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      // Background checks are not refusals the person made.
      expect(
        await pool.db
          .select()
          .from(schema.quotaDenial)
          .where(eq(schema.quotaDenial.userId, person)),
      ).toHaveLength(0);
      // A manual request is refused at once.
      expect((await compact(chat.id, {}, person)).status).toBe(429);

      await pool.db.execute(sql`delete from quota_policy`);
      await pool.db
        .update(schema.conversationCompactionJob)
        .set({ runAfter: new Date(Date.now() - 1000) });
      expect(await processQueue()).toBe(1);
      expect((await compactions(chat.id))[0]).toMatchObject({
        reason: 'automatic',
        summary: 'WHEN-ALLOWED',
        userId: person,
      });
    });

    it('drops queued work when the conversation is trashed, and discards a summary being made', async () => {
      const chat = await thread();
      await seedTurns(chat.id, 1, 4);
      await queued(chat.id, { runAfter: new Date(Date.now() + 60_000) });
      const trash = (threadId: string) =>
        app.request(`/api/threads/${threadId}`, { method: 'DELETE' });
      expect((await trash(chat.id)).status).toBe(200);
      expect(await jobs(chat.id)).toHaveLength(0);

      const other = await thread();
      await seedTurns(other.id, 1, 4);
      const pending = held('TOO-LATE');
      const model = script([], [pending.step]);
      expect((await compact(other.id)).status).toBe(202);
      await pending.running;
      expect((await trash(other.id)).status).toBe(200);
      expect(await jobs(other.id)).toHaveLength(0);
      pending.release();
      await background();
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(await compactions(other.id)).toHaveLength(0);

      // A request that was claimed just before the conversation was trashed.
      const third = await thread();
      await seedTurns(third.id, 1, 4);
      await queued(third.id);
      await pool.db
        .update(schema.thread)
        .set({ deletedAt: new Date() })
        .where(eq(schema.thread.id, third.id));
      expect(await processQueue()).toBe(1);
      expect(await jobs(third.id)).toHaveLength(0);
      expect(model.doGenerateCalls).toHaveLength(1);
    });

    it('keeps the newest cut and discards a summary whose messages changed meanwhile', async () => {
      const chat = await thread();
      const seeded = await seedTurns(chat.id, 1, 4);
      const racing = (firstKeptMessageId: string) =>
        pool.db.insert(schema.conversationCompaction).values({
          threadId: chat.id,
          userId: owner,
          firstKeptMessageId,
          summary: 'RACING',
          reason: 'manual',
          messagesSummarized: 6,
          tokensSummarized: 10,
          modelSlug: 'test-model',
        });
      // A further cut lands first: this one (at turn 3) is discarded.
      script(
        [],
        [
          async () => {
            await racing(seeded[6]!.id);
            return summary('SHORTER-CUT');
          },
        ],
      );
      expect((await compact(chat.id)).status).toBe(202);
      await background();
      expect((await compactions(chat.id)).map((record) => record.summary)).toEqual(['RACING']);

      // A message it summarised is gone: discarded.
      const other = await thread();
      const otherSeeded = await seedTurns(other.id, 1, 4);
      script(
        [],
        [
          async () => {
            await pool.db.delete(schema.message).where(eq(schema.message.id, otherSeeded[1]!.id));
            return summary('STALE');
          },
        ],
      );
      expect((await compact(other.id)).status).toBe(202);
      await background();
      expect(await compactions(other.id)).toHaveLength(0);

      // An earlier cut lands first: this one reaches further and wins.
      const third = await thread();
      const thirdSeeded = await seedTurns(third.id, 1, 6);
      script(
        [],
        [
          async () => {
            await pool.db.insert(schema.conversationCompaction).values({
              threadId: third.id,
              userId: owner,
              firstKeptMessageId: thirdSeeded[2]!.id,
              summary: 'EARLIER-CUT',
              reason: 'automatic',
              messagesSummarized: 2,
              tokensSummarized: 10,
              modelSlug: 'test-model',
            });
            return summary('FURTHER-CUT');
          },
        ],
      );
      expect((await compact(third.id)).status).toBe(202);
      await background();
      expect((await compactions(third.id)).map((record) => record.summary)).toEqual([
        'EARLIER-CUT',
        'FURTHER-CUT',
      ]);
      expect((await compactionStatus(third.id)).compaction).toMatchObject({
        reason: 'manual',
        firstKeptMessageId: thirdSeeded[6]!.id,
      });
    });
  });
});
