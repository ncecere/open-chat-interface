import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { getDisplayTimezone } from '../lifecycle/settings.js';
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
 * What people are doing, as distinct from what it costs.
 *
 * Counts only. The message and thread tables hold conversation content, so
 * nothing here selects a title, a body, or a message part.
 */
export async function activitySummary(days: number): Promise<ActivitySummary> {
  const start = rangeStart(days);

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

  const [messages] = await db.execute<{
    sent: string;
    searched: string;
    errored: string;
    cancelled: string;
  }>(sql`
    select
      count(*) filter (where role = 'user') as sent,
      count(*) filter (where web_search_used = true) as searched,
      count(*) filter (where status = 'error') as errored,
      count(*) filter (where status = 'cancelled') as cancelled
    from message
    where created_at >= ${start}::timestamptz
  `);

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
  // when their settled events that day add up to at least one.
  const rollups = (await reportSource(options)) === 'rollups';
  const straddling = rollups ? await straddlingHours(new Date(start), timezone) : [];
  const rows = rollups
    ? await db.execute<{ day: string; messages: string; active_users: string }>(sql`
          select d.day, sum(d.messages) as messages,
            count(*) filter (where d.user_id is not null and d.settled > 0) as active_users
          from (
            select to_char(date_trunc('day', p.at at time zone ${timezone}), 'YYYY-MM-DD') as day,
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
