import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, runPostMigrations } from '@oci/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The usage page's Overview tab activity counts against real PostgreSQL.
 *
 * The message counts have two implementations: one pass over every message of
 * the range (`scan`, as before 0.11 and until the post-deploy indexes exist),
 * and one count per figure shaped for its partial index (`indexed`,
 * post-deploy steps 0002 to 0005). These tests generate conversations and
 * messages (every role and status, web search on and off, temporary and
 * branched conversations, conversations in the trash, rows exactly on and
 * either side of each range's start, people whose accounts are then deleted),
 * and check both implementations against each other and against counts made
 * here from the generated rows, before and after the indexes are built. Then
 * they check each count really is answered from its index.
 */
const state = vi.hoisted(() => ({ db: null as Database | null, sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));

const { activitySummary, MESSAGE_ACTIVITY_INDEX_STEP } = await import(
  '../../services/usage-report/activity.js'
);
const { resetReadinessCache } = await import('../../services/migrations/readiness.js');

const available = await livePostgresAvailable();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Not on an hour or a second, so every range starts part-way through one. */
const NOW = new Date('2026-07-15T10:17:23.456Z');
const RANGES = [7, 30, 90];
/** Ends of the range to check, including one a day before NOW and one at it. */
const ENDS = [NOW, new Date(NOW.getTime() - DAY), new Date(NOW.getTime() - 13 * HOUR - 1)];
const ROLES = ['user', 'assistant', 'system'] as const;
const STATUSES = ['complete', 'complete', 'complete', 'streaming', 'error', 'cancelled'] as const;
const quiet = { info: () => {}, warn: () => {} };

/** The literal text of a Drizzle `sql` statement, without its parameters. */
function text(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join('');
}

function prng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ThreadRow {
  id: string;
  userId: string;
  createdAt: Date;
  temporary: boolean;
  parentThreadId: string | null;
  deletedAt: Date | null;
}

interface MessageRow {
  id: string;
  threadId: string;
  userId: string;
  role: (typeof ROLES)[number];
  status: (typeof STATUSES)[number];
  webSearchUsed: boolean;
  createdAt: Date;
}

// Each comparison runs every range and end both ways: generous under a loaded CI.
describe.skipIf(!available)('live: usage Overview activity counts', { timeout: 60_000 }, () => {
  let live: LiveDatabase;
  let client: postgres.Sql;
  let organizationId: string;
  let threads: ThreadRow[] = [];
  let messages: MessageRow[] = [];
  const random = prng(11);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  /** An instant somewhere in the last 100 days, often right at a range start. */
  function instant(): Date {
    const roll = random();
    if (roll < 0.25) {
      // On, or a microsecond-scale step either side of, some range's start.
      const end = pick(ENDS).getTime();
      const start = end - pick(RANGES) * DAY;
      return new Date(start + pick([-1, 0, 0, 1]));
    }
    if (roll < 0.3) return new Date(pick(ENDS).getTime() + pick([-1, 0, 1]));
    return new Date(NOW.getTime() - random() * 100 * DAY);
  }

  async function seed(people: string[], count: number) {
    const newThreads: ThreadRow[] = [];
    for (let index = 0; index < count; index += 1) {
      const userId = pick(people);
      const own = threads.filter((thread) => thread.userId === userId);
      newThreads.push({
        id: randomUUID(),
        userId,
        createdAt: instant(),
        temporary: random() < 0.1,
        parentThreadId: own.length && random() < 0.15 ? pick(own).id : null,
        deletedAt: random() < 0.1 ? NOW : null,
      });
      threads.push(newThreads.at(-1)!);
    }
    await client`
      insert into thread ${client(
        newThreads.map((thread) => ({
          id: thread.id,
          organization_id: organizationId,
          user_id: thread.userId,
          title: 'Seeded',
          temporary: thread.temporary,
          parent_thread_id: thread.parentThreadId,
          deleted_at: thread.deletedAt?.toISOString() ?? null,
          created_at: thread.createdAt.toISOString(),
          updated_at: thread.createdAt.toISOString(),
        })),
      )}`;

    const newMessages: MessageRow[] = [];
    for (const thread of newThreads) {
      const length = 1 + Math.floor(random() * 14);
      for (let position = 0; position < length; position += 1) {
        const role = position % 2 === 0 ? 'user' : pick(ROLES);
        newMessages.push({
          id: randomUUID(),
          threadId: thread.id,
          userId: thread.userId,
          role,
          status: role === 'user' ? 'complete' : pick(STATUSES),
          webSearchUsed: role !== 'user' && random() < 0.2,
          createdAt: position === 0 ? thread.createdAt : instant(),
        });
      }
    }
    for (let from = 0; from < newMessages.length; from += 1000) {
      await client`
        insert into message ${client(
          newMessages.slice(from, from + 1000).map((message, position) => ({
            id: message.id,
            thread_id: message.threadId,
            user_id: message.userId,
            role: message.role,
            status: message.status,
            web_search_used: message.webSearchUsed,
            position,
            created_at: message.createdAt.toISOString(),
            updated_at: message.createdAt.toISOString(),
          })),
        )}`;
    }
    messages.push(...newMessages);
  }

  /** The four message figures (and the thread ones) counted here, from the rows. */
  function expected(days: number, end: Date) {
    const start = end.getTime() - days * DAY;
    const inRange = messages.filter((message) => message.createdAt.getTime() >= start);
    const threadsInRange = threads.filter((thread) => thread.createdAt.getTime() >= start);
    return {
      threadsCreated: threadsInRange.length,
      messagesSent: inRange.filter((message) => message.role === 'user').length,
      searchesRun: inRange.filter((message) => message.webSearchUsed).length,
      branchesCreated: threadsInRange.filter((thread) => thread.parentThreadId !== null).length,
      temporaryThreads: threadsInRange.filter((thread) => thread.temporary).length,
      erroredResponses: inRange.filter((message) => message.status === 'error').length,
      cancelledResponses: inRange.filter((message) => message.status === 'cancelled').length,
    };
  }

  async function compareAll(label: string) {
    let nonZero = 0;
    for (const days of RANGES) {
      for (const now of ENDS) {
        const scan = await activitySummary(days, { now, messageCounts: 'scan' });
        const indexed = await activitySummary(days, { now, messageCounts: 'indexed' });
        expect(indexed, `${label}: ${days} days to ${now.toISOString()}`).toEqual(scan);
        expect(scan).toMatchObject(expected(days, now));
        if (scan.messagesSent && scan.searchesRun && scan.cancelledResponses) nonZero += 1;
      }
    }
    // The data exercises every figure in every range.
    expect(nonZero).toBe(RANGES.length * ENDS.length);
  }

  beforeAll(async () => {
    live = await createLiveDatabase('usage_activity');
    state.db = live.db;
    client = createDatabase(live.connectionString, { max: 4 }).sql;
    state.sql = client;
    organizationId = await seedOrganization(live.db);
    const people: string[] = [];
    for (let index = 0; index < 8; index += 1) people.push(await seedUser(live.db, organizationId));
    await seed(people, 500);
  });

  afterAll(async () => {
    state.db = null;
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  it('places rows exactly on the start of the ranges it checks', () => {
    const starts = new Set(RANGES.flatMap((days) => ENDS.map((end) => end.getTime() - days * DAY)));
    expect(
      messages.filter((message) => starts.has(message.createdAt.getTime())).length,
    ).toBeGreaterThan(10);
    expect(
      messages.filter((message) => starts.has(message.createdAt.getTime() + 1)).length,
    ).toBeGreaterThan(10);
  });

  it('counts the same both ways, and as the rows say, without the indexes', async () => {
    await compareAll('no indexes');
  });

  it('reads the scan until the indexes are built, then the indexed counts', async () => {
    resetReadinessCache();
    const spy = vi.spyOn(live.db, 'execute');
    await activitySummary(30, { now: NOW });
    const statements = spy.mock.calls.map(([query]) => text(query));
    expect(statements.some((text) => text.includes('filter (where role'))).toBe(true);
    spy.mockClear();

    await runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] });
    resetReadinessCache();
    await activitySummary(30, { now: NOW });
    const after = spy.mock.calls.map(([query]) => text(query));
    expect(after.some((text) => text.includes('filter (where role'))).toBe(false);
    expect(after.some((text) => text.includes("and role = 'user'"))).toBe(true);
    spy.mockRestore();
    const [step] = await client<{ done: boolean }[]>`
      select finished_at is not null as done from oci_post_migration
      where name = ${MESSAGE_ACTIVITY_INDEX_STEP}`;
    expect(step?.done).toBe(true);
  });

  it('counts the same with the indexes built, after deleting accounts and changing statuses', async () => {
    await compareAll('indexes built');

    // Deleting an account deletes its conversations and messages (cascade):
    // both ways stop counting them.
    const [gone] = await client<{ id: string }[]>`
      select user_id as id from message group by user_id order by count(*) desc limit 1`;
    await client`delete from "user" where id = ${gone!.id}`;
    messages = messages.filter((message) => message.userId !== gone!.id);
    threads = threads.filter((thread) => thread.userId !== gone!.id);

    // Replies finish, fail or are cancelled after they are written.
    const streaming = messages.filter((message) => message.status === 'streaming');
    expect(streaming.length).toBeGreaterThan(20);
    for (const [index, message] of streaming.entries()) {
      message.status = index % 3 === 0 ? 'error' : index % 3 === 1 ? 'cancelled' : 'complete';
      message.webSearchUsed = index % 2 === 0;
    }
    await client`
      update message m set status = c.status, web_search_used = c.web_search_used
      from jsonb_to_recordset(${JSON.stringify(
        streaming.map((message) => ({
          id: message.id,
          status: message.status,
          web_search_used: message.webSearchUsed,
        })),
      )}::jsonb) as c(id text, status text, web_search_used boolean)
      where m.id = c.id`;

    // New people and conversations after the indexes exist.
    const people = [
      await seedUser(live.db, organizationId),
      await seedUser(live.db, organizationId),
    ];
    await seed(people, 150);
    await client`analyze message`;
    await client`analyze thread`;
    await compareAll('after changes');
  });

  it('answers each message count index-only from its own partial index, and threads from theirs', async () => {
    const start = new Date(NOW.getTime() - 30 * DAY).toISOString();
    // A test database is too small for the planner to prefer an index on its
    // own; with sequential and bitmap scans off it uses one only if the
    // query's predicate implies the index's.
    const plans = await client.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_bitmapscan = off`;
      const explain = async (where: string) => {
        const rows = await tx.unsafe<{ 'QUERY PLAN': string }[]>(
          `explain select count(*) from message where created_at >= $1::timestamptz and ${where}`,
          [start],
        );
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      };
      const thread = await tx.unsafe<{ 'QUERY PLAN': string }[]>(
        `explain select count(*), count(*) filter (where temporary = true),
           count(*) filter (where parent_thread_id is not null)
         from thread where created_at >= $1::timestamptz`,
        [start],
      );
      return {
        sent: await explain(`role = 'user'`),
        searched: await explain('web_search_used'),
        errored: await explain(`status = 'error'`),
        cancelled: await explain(`status = 'cancelled'`),
        thread: thread.map((row) => row['QUERY PLAN']).join('\n'),
      };
    });
    expect(plans.sent).toMatch(/Index Only Scan using message_sent_created_at_idx/);
    expect(plans.searched).toMatch(/Index Only Scan using message_web_search_created_at_idx/);
    expect(plans.errored).toMatch(/Index Only Scan using message_error_created_at_idx/);
    expect(plans.cancelled).toMatch(/Index Only Scan using message_cancelled_created_at_idx/);
    expect(plans.thread).toMatch(/Index Only Scan using thread_created_at_idx/);
  });
});
