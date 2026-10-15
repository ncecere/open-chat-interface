import { eq, schema, sql } from '@oci/db';
import { GROUP_USAGE_MAX_PEOPLE, type GroupUsage } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { type ReportOptions, rangeStart, reportSource } from '../usage-report/common.js';
import { rollupRows } from '../usage-report/source.js';
import { memberCounts } from './membership.js';

interface Row extends Record<string, unknown> {
  user_id: string;
  name: string;
  email: string;
  messages: string;
  tokens_in: string;
  tokens_out: string;
  cost_micros: string;
  all_messages: string;
  all_tokens_in: string;
  all_tokens_out: string;
  all_cost_micros: string;
  people: string;
}

/**
 * What the group's CURRENT members used in the last `days` days (the card on the
 * administrator's group page). It is a view of the people in the group now,
 * not a historical label: someone who left is not counted, someone who joined
 * brings their history, and a person in two groups appears in both. The reports
 * have no group dimension on purpose, because those would relabel history with
 * every membership change.
 *
 * Two implementations that return the same figures, as for the usage reports
 * (usage-report/consumption.ts): the hourly rollups once their backfill has
 * finished, the events before. Identity and counts only, never content.
 */
export async function groupUsage(
  groupId: string,
  days: number,
  options: ReportOptions = {},
): Promise<GroupUsage> {
  const [group] = await db
    .select({ id: schema.group.id })
    .from(schema.group)
    .where(eq(schema.group.id, groupId))
    .limit(1);
  if (!group) throw notFound('Group not found');

  const start = rangeStart(days, options.now);
  const source =
    (await reportSource(options)) === 'rollups'
      ? sql`
        select p.user_id, sum(p.messages) as messages, sum(p.tokens_in) as tokens_in,
          sum(p.tokens_out) as tokens_out, sum(p.cost_micros) as cost_micros
        from (${rollupRows({ start: new Date(start), level: 'person' })}) p
        join group_member m on m.user_id = p.user_id and m.group_id = ${groupId}
        group by p.user_id
        having sum(p.settled_events) > 0`
      : sql`
        select e.user_id, sum(e.message_count) as messages, sum(e.tokens_in::bigint) as tokens_in,
          sum(e.tokens_out::bigint) as tokens_out, sum(e.cost_micros) as cost_micros
        from usage_event e
        join group_member m on m.user_id = e.user_id and m.group_id = ${groupId}
        where e.occurred_at >= ${start}::timestamptz and e.pending = false
        group by e.user_id`;

  const rows = await db.execute<Row>(sql`
    with grouped as (${source})
    select g.user_id, u.name, u.email, g.messages, g.tokens_in, g.tokens_out, g.cost_micros,
      sum(g.messages) over () as all_messages, sum(g.tokens_in) over () as all_tokens_in,
      sum(g.tokens_out) over () as all_tokens_out, sum(g.cost_micros) over () as all_cost_micros,
      count(*) over () as people
    from grouped g
    join "user" u on u.id = g.user_id
    order by g.cost_micros desc, g.messages desc, g.user_id
    limit ${GROUP_USAGE_MAX_PEOPLE}
  `);

  const first = rows[0];
  const members = (await memberCounts([groupId])).get(groupId)?.members ?? 0;
  return {
    days,
    since: start,
    memberCount: members,
    totals: {
      messages: Number(first?.all_messages ?? 0),
      tokensIn: Number(first?.all_tokens_in ?? 0),
      tokensOut: Number(first?.all_tokens_out ?? 0),
      costMicros: Number(first?.all_cost_micros ?? 0),
    },
    people: [...rows].map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      messages: Number(row.messages),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      costMicros: Number(row.cost_micros),
    })),
    truncated: Number(first?.people ?? 0) > rows.length,
  };
}
