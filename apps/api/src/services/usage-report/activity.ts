import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { getDisplayTimezone } from '../lifecycle/settings.js';
import { isPostStepDone } from '../migrations/readiness.js';
import { type ReportOptions, rangeStart, reportSource } from './common.js';
import { rollupRows, straddlingHours } from './source.js';

export interface ActivitySummary {
  threadsCreated: number;
  messagesSent: number;
  attachmentsUploaded: number;
  sharesCreated: number;
  searchesRun: number;
  branchesCreated: number;
  temporaryThreads: number;
  erroredResponses: number;
  cancelledResponses: number;
}

/**
 * The last of the post-deploy steps that build the partial indexes the
 * message counts read (0002 failed, 0003 sent, 0004 web search, 0005
 * cancelled). `migrate --post` runs steps in order and stops at a failure, so
 * this one finished means all four are built.
 */
export const MESSAGE_ACTIVITY_INDEX_STEP = '0005_message_cancelled_created_at_index';

/**
 * How the message counts are read. Both return the same numbers (the live
 * test usage-activity.live.test.ts compares them):
 *
 * - `indexed`: one count per figure, each matching the predicate of its
 *   partial index (post-deploy steps 0002 to 0005), so each is an index-only
 *   scan of just those messages;
 * - `scan`: one pass over every message of the range, as before 0.11, used
 *   until those indexes are built: without them the four counts would be four
 *   passes.
 */
export type MessageCountsMethod = 'indexed' | 'scan';

export interface ActivityOptions {
  /** The end of the range (default: now). */
  now?: Date;
  /** Default: `indexed` once the indexes are built, else `scan`. */
  messageCounts?: MessageCountsMethod;
}

async function messageCountsMethod(options: ActivityOptions): Promise<MessageCountsMethod> {
  if (options.messageCounts) return options.messageCounts;
  return (await isPostStepDone(MESSAGE_ACTIVITY_INDEX_STEP)) ? 'indexed' : 'scan';
}

type MessageCounts = {
  sent: string;
  searched: string;
  errored: string;
  cancelled: string;
};

async function messageCounts(start: string, method: MessageCountsMethod) {
  if (method === 'indexed') {
    // Each predicate is exactly its index's (a partial index is only used
    // when the query implies its predicate), and only `created_at` is read.
    const [row] = await db.execute<MessageCounts>(sql`
      select
        (select count(*) from message
          where created_at >= ${start}::timestamptz and role = 'user') as sent,
        (select count(*) from message
          where created_at >= ${start}::timestamptz and web_search_used) as searched,
        (select count(*) from message
          where created_at >= ${start}::timestamptz and status = 'error') as errored,
        (select count(*) from message
          where created_at >= ${start}::timestamptz and status = 'cancelled') as cancelled
    `);
    return row;
  }
  const [row] = await db.execute<MessageCounts>(sql`
    select
      count(*) filter (where role = 'user') as sent,
      count(*) filter (where web_search_used = true) as searched,
      count(*) filter (where status = 'error') as errored,
      count(*) filter (where status = 'cancelled') as cancelled
    from message
    where created_at >= ${start}::timestamptz
  `);
  return row;
}

/**
 * What people are doing, as distinct from what it costs.
 *
 * Counts only. The message and thread tables hold conversation content, so
 * nothing here selects a title, a body, or a message part.
 */
export async function activitySummary(
  days: number,
  options: ActivityOptions = {},
): Promise<ActivitySummary> {
  const start = rangeStart(days, options.now);
  const method = await messageCountsMethod(options);

  // Index-only once post-deploy step 0006 has built `thread_created_at_idx`
  // (it includes both filtered columns); the same statement either way.
  const [threads] = await db.execute<{
    total: string;
    temporary: string;
    branched: string;
  }>(sql`
    select
      count(*) as total,
      count(*) filter (where temporary = true) as temporary,
      count(*) filter (where parent_thread_id is not null) as branched
    from thread
    where created_at >= ${start}::timestamptz
  `);

  const messages = await messageCounts(start, method);

  const [attachments] = await db.execute<{ total: string }>(sql`
    select count(*) as total from attachment where created_at >= ${start}::timestamptz
  `);

  const [shares] = await db.execute<{ total: string }>(sql`
    select count(*) as total from share_link where created_at >= ${start}::timestamptz
  `);

  return {
    threadsCreated: Number(threads?.total ?? 0),
    messagesSent: Number(messages?.sent ?? 0),
    attachmentsUploaded: Number(attachments?.total ?? 0),
    sharesCreated: Number(shares?.total ?? 0),
    searchesRun: Number(messages?.searched ?? 0),
    branchesCreated: Number(threads?.branched ?? 0),
    temporaryThreads: Number(threads?.temporary ?? 0),
    erroredResponses: Number(messages?.errored ?? 0),
    cancelledResponses: Number(messages?.cancelled ?? 0),
  };
}

export interface DailyActivity {
  day: string;
  messages: number;
  activeUsers: number;
}

/** Daily message volume and distinct people, bucketed in the display zone. */
export async function dailyActivity(
  days: number,
  options: ReportOptions = {},
): Promise<DailyActivity[]> {
  const timezone = await getDisplayTimezone();
  const start = rangeStart(days, options.now);

  // From the rollups: per day and person first, so a person counts on a day
  // when their settled events that day add up to at least one. The day is
  // formatted once per day rather than once per rollup row (about 20 % of the
  // statement at the scale harness's `medium`).
  const rollups = (await reportSource(options)) === 'rollups';
  const straddling = rollups ? await straddlingHours(new Date(start), timezone) : [];
  const rows = rollups
    ? await db.execute<{ day: string; messages: string; active_users: string }>(sql`
          select to_char(d.day, 'YYYY-MM-DD') as day, sum(d.messages) as messages,
            count(*) filter (where d.user_id is not null and d.settled > 0) as active_users
          from (
            select date_trunc('day', p.at at time zone ${timezone}) as day,
              p.user_id, sum(p.messages) as messages, sum(p.settled_events) as settled
            from (${rollupRows({ start: new Date(start), level: 'person', straddling })}) p
            group by 1, 2
          ) d
          group by d.day
          having sum(d.settled) > 0
          order by d.day
        `)
    : await db.execute<{ day: string; messages: string; active_users: string }>(sql`
          select
            to_char(date_trunc('day', occurred_at at time zone ${timezone}), 'YYYY-MM-DD') as day,
            sum(message_count) as messages,
            count(distinct user_id) as active_users
          from usage_event
          where occurred_at >= ${start}::timestamptz and pending = false
          group by 1
          order by 1
        `);

  return rows.map((row) => ({
    day: row.day,
    messages: Number(row.messages),
    activeUsers: Number(row.active_users),
  }));
}
