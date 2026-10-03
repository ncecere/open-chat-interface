import { and, eq, gte, inArray, schema, sql } from '@oci/db';
import { DELETED_ACCOUNTS_LABEL } from '@oci/shared';
import { db } from '../../db/index.js';
import { getDisplayTimezone } from '../lifecycle/settings.js';
import { type Bounded, rangeStart } from './common.js';

/**
 * Instance totals. A deleted account's usage is kept without the person
 * (migration 0038), so it stays in every sum; `activeUsers` counts the people
 * who still have an account, since nothing is left to tell deleted ones apart.
 * In-flight reservations are left out, as in every other figure here: they are
 * estimates, and an account deletion removes them.
 */
export interface UsageTotals {
  messages: number;
  tokens: number;
  costMicros: number;
  activeUsers: number;
}

export async function usageTotals(days: number): Promise<UsageTotals> {
  const [row] = await db
    .select({
      messages: sql<number>`coalesce(sum(${schema.usageEvent.messageCount}), 0)::bigint`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn}::bigint + ${schema.usageEvent.tokensOut}::bigint), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros}), 0)::bigint`,
      activeUsers: sql<number>`count(distinct ${schema.usageEvent.userId})::int`,
    })
    .from(schema.usageEvent)
    .where(
      sql`${schema.usageEvent.occurredAt} >= ${rangeStart(days)}::timestamptz and ${schema.usageEvent.pending} = false`,
    );

  return {
    messages: Number(row?.messages ?? 0),
    tokens: Number(row?.tokens ?? 0),
    costMicros: Number(row?.costMicros ?? 0),
    activeUsers: Number(row?.activeUsers ?? 0),
  };
}

export interface DailyUsage {
  day: string;
  messages: number;
  tokens: number;
  costMicros: number;
}

/**
 * Daily consumption, bucketed in the instance display timezone.
 *
 * Events carry a real timestamp, so the boundary can be shifted at query time.
 * The daily rollup could not answer this: it stores an already-bucketed UTC
 * date string, and once bucketed the information needed to re-bucket is gone.
 */
export async function dailyUsage(days: number): Promise<DailyUsage[]> {
  const timezone = await getDisplayTimezone();

  const rows = await db.execute<{
    day: string;
    messages: string;
    tokens: string;
    cost_micros: string;
  }>(sql`
    select
      to_char(date_trunc('day', occurred_at at time zone ${timezone}), 'YYYY-MM-DD') as day,
      sum(message_count) as messages,
      sum(tokens_in::bigint + tokens_out::bigint) as tokens,
      sum(cost_micros) as cost_micros
    from usage_event
    where occurred_at >= ${rangeStart(days)}::timestamptz and pending = false
    group by 1
    order by 1
  `);

  return rows.map((row) => ({
    day: row.day,
    messages: Number(row.messages),
    tokens: Number(row.tokens),
    costMicros: Number(row.cost_micros),
  }));
}

export interface ModelUsage {
  modelSlug: string;
  displayName: string | null;
  labId: string | null;
  enabled: boolean;
  messages: number;
  tokens: number;
  costMicros: number;
  errors: number;
}

/**
 * Consumption per model, with the share of responses that failed.
 *
 * Error counts come from message status only. The message table holds
 * conversation content, so nothing but the status column is read here.
 */
export async function modelUsage(days: number, limit = 25): Promise<Bounded<ModelUsage>> {
  const start = rangeStart(days);

  // A curated catalog can hold hundreds of models, so the table is capped and
  // the remainder reported rather than rendered.
  const [counted] = await db.execute<{ total: string }>(sql`
    select count(distinct model_slug) as total
    from usage_event
    where occurred_at >= ${start}::timestamptz and pending = false
  `);

  const rows = await db.execute<{
    model_slug: string;
    display_name: string | null;
    lab_id: string | null;
    enabled: boolean | null;
    messages: string;
    tokens: string;
    cost_micros: string;
  }>(sql`
    select
      e.model_slug,
      m.display_name,
      m.lab_id,
      m.enabled,
      sum(e.message_count) as messages,
      sum(e.tokens_in::bigint + e.tokens_out::bigint) as tokens,
      sum(e.cost_micros) as cost_micros
    from usage_event e
    left join model m on m.slug = e.model_slug
    where e.occurred_at >= ${start}::timestamptz and e.pending = false
    group by e.model_slug, m.display_name, m.lab_id, m.enabled
    order by sum(e.cost_micros) desc, sum(e.message_count) desc
    limit ${limit}
  `);

  // Only the models actually shown need an error count.
  const shownSlugs = rows.map((row) => row.model_slug);
  // Built through the query builder so the slug list is bound as an array
  // rather than flattened into a single malformed parameter.
  const errorRows =
    shownSlugs.length === 0
      ? []
      : await db
          .select({
            modelSlug: schema.message.modelSlug,
            errors: sql<number>`count(*)::int`,
          })
          .from(schema.message)
          .where(
            and(
              gte(schema.message.createdAt, new Date(start)),
              eq(schema.message.status, 'error'),
              inArray(schema.message.modelSlug, shownSlugs),
            ),
          )
          .groupBy(schema.message.modelSlug);

  const errorsBySlug = new Map(
    errorRows.flatMap((row) => (row.modelSlug ? [[row.modelSlug, Number(row.errors)]] : [])),
  );

  return {
    entries: rows.map((row) => ({
      modelSlug: row.model_slug,
      displayName: row.display_name,
      labId: row.lab_id,
      enabled: row.enabled ?? false,
      messages: Number(row.messages),
      tokens: Number(row.tokens),
      costMicros: Number(row.cost_micros),
      errors: errorsBySlug.get(row.model_slug) ?? 0,
    })),
    totalCount: Number(counted?.total ?? 0),
  };
}

export type ConsumerUsage = {
  messages: number;
  tokens: number;
  costMicros: number;
} & (
  | { deleted: false; userId: string; name: string; email: string; role: string }
  /** Every deleted account's usage together, with nothing that identifies anyone. */
  | { deleted: true; userId: null; name: string; email: null; role: null }
);

/**
 * Heaviest consumers. Identity and counts only; never conversation content.
 * The usage of deleted accounts, kept without the person, is one
 * "Deleted accounts" row ranked with the rest.
 */
export async function topConsumers(days: number, limit = 10): Promise<Bounded<ConsumerUsage>> {
  // Grows with the user base, so the page shows a leaderboard and says how
  // many people are behind it rather than listing everyone. Deleted accounts
  // count once, as the single row they are shown as.
  const [counted] = await db.execute<{ total: string }>(sql`
    select count(distinct user_id) + coalesce(bool_or(user_id is null), false)::int as total
    from usage_event
    where occurred_at >= ${rangeStart(days)}::timestamptz and pending = false
  `);

  const rows = await db.execute<{
    user_id: string | null;
    name: string | null;
    email: string | null;
    role: string | null;
    messages: string;
    tokens: string;
    cost_micros: string;
  }>(sql`
    select
      e.user_id, u.name, u.email, u.role,
      sum(e.message_count) as messages,
      sum(e.tokens_in::bigint + e.tokens_out::bigint) as tokens,
      sum(e.cost_micros) as cost_micros
    from usage_event e
    left join "user" u on u.id = e.user_id
    where e.occurred_at >= ${rangeStart(days)}::timestamptz and e.pending = false
    group by e.user_id, u.name, u.email, u.role
    order by sum(e.cost_micros) desc, sum(e.message_count) desc
    limit ${limit}
  `);

  return {
    entries: rows.map((row): ConsumerUsage => {
      const amounts = {
        messages: Number(row.messages),
        tokens: Number(row.tokens),
        costMicros: Number(row.cost_micros),
      };
      return row.user_id === null
        ? {
            deleted: true,
            userId: null,
            name: DELETED_ACCOUNTS_LABEL,
            email: null,
            role: null,
            ...amounts,
          }
        : // The key guarantees the account exists while it is referenced.
          {
            deleted: false,
            userId: row.user_id,
            name: row.name!,
            email: row.email!,
            role: row.role!,
            ...amounts,
          };
    }),
    totalCount: Number(counted?.total ?? 0),
  };
}
