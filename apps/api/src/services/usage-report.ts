import { schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { getDisplayTimezone } from './lifecycle/settings.js';

/**
 * How far back per-event history reaches. Beyond this, events have been pruned
 * and only the UTC-bucketed daily rollup survives, so a longer range would
 * silently change what a "day" means.
 */
export const EVENT_HISTORY_DAYS = 90;

export interface UsageReportRange {
  days: number;
  timezone: string;
  /** True when the range is answered from local-time event data. */
  exact: boolean;
}

/** Raw SQL binds text, so the boundary is passed as an ISO string. */
function rangeStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

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
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.tokensIn} + ${schema.usageEvent.tokensOut}), 0)::bigint`,
      costMicros: sql<number>`coalesce(sum(${schema.usageEvent.costMicros}), 0)::bigint`,
      activeUsers: sql<number>`count(distinct ${schema.usageEvent.userId})::int`,
    })
    .from(schema.usageEvent)
    .where(sql`${schema.usageEvent.occurredAt} >= ${rangeStart(days)}::timestamptz`);

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
      sum(tokens_in + tokens_out) as tokens,
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
export async function modelUsage(days: number): Promise<ModelUsage[]> {
  const start = rangeStart(days);

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
      sum(e.tokens_in + e.tokens_out) as tokens,
      sum(e.cost_micros) as cost_micros
    from usage_event e
    left join model m on m.slug = e.model_slug
    where e.occurred_at >= ${start}::timestamptz and e.pending = false
    group by e.model_slug, m.display_name, m.lab_id, m.enabled
    order by sum(e.cost_micros) desc, sum(e.message_count) desc
  `);

  const errorRows = await db.execute<{ model_slug: string; errors: string }>(sql`
    select model_slug, count(*) as errors
    from message
    where created_at >= ${start}::timestamptz and status = 'error' and model_slug is not null
    group by model_slug
  `);
  const errorsBySlug = new Map(errorRows.map((row) => [row.model_slug, Number(row.errors)]));

  return rows.map((row) => ({
    modelSlug: row.model_slug,
    displayName: row.display_name,
    labId: row.lab_id,
    enabled: row.enabled ?? false,
    messages: Number(row.messages),
    tokens: Number(row.tokens),
    costMicros: Number(row.cost_micros),
    errors: errorsBySlug.get(row.model_slug) ?? 0,
  }));
}

export interface ConsumerUsage {
  userId: string;
  name: string;
  email: string;
  role: string;
  messages: number;
  tokens: number;
  costMicros: number;
}

/** Heaviest consumers. Identity and counts only; never conversation content. */
export async function topConsumers(days: number, limit = 10): Promise<ConsumerUsage[]> {
  const rows = await db.execute<{
    user_id: string;
    name: string;
    email: string;
    role: string;
    messages: string;
    tokens: string;
    cost_micros: string;
  }>(sql`
    select
      e.user_id, u.name, u.email, u.role,
      sum(e.message_count) as messages,
      sum(e.tokens_in + e.tokens_out) as tokens,
      sum(e.cost_micros) as cost_micros
    from usage_event e
    join "user" u on u.id = e.user_id
    where e.occurred_at >= ${rangeStart(days)}::timestamptz and e.pending = false
    group by e.user_id, u.name, u.email, u.role
    order by sum(e.cost_micros) desc, sum(e.message_count) desc
    limit ${limit}
  `);

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    messages: Number(row.messages),
    tokens: Number(row.tokens),
    costMicros: Number(row.cost_micros),
  }));
}

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
export async function dailyActivity(days: number): Promise<DailyActivity[]> {
  const timezone = await getDisplayTimezone();

  const rows = await db.execute<{ day: string; messages: string; active_users: string }>(sql`
    select
      to_char(date_trunc('day', occurred_at at time zone ${timezone}), 'YYYY-MM-DD') as day,
      sum(message_count) as messages,
      count(distinct user_id) as active_users
    from usage_event
    where occurred_at >= ${rangeStart(days)}::timestamptz and pending = false
    group by 1
    order by 1
  `);

  return rows.map((row) => ({
    day: row.day,
    messages: Number(row.messages),
    activeUsers: Number(row.active_users),
  }));
}

export interface StorageSummary {
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
  topUsers: Array<{ userId: string; name: string; email: string; bytes: number; files: number }>;
}

/** Where object storage is actually going. */
export async function storageSummary(): Promise<StorageSummary> {
  const [totals] = await db.execute<{
    live_bytes: string;
    live_files: string;
    pending_bytes: string;
    pending_files: string;
  }>(sql`
    select
      coalesce(sum(size_bytes) filter (where deleted_at is null), 0) as live_bytes,
      count(*) filter (where deleted_at is null) as live_files,
      coalesce(sum(size_bytes) filter (where deleted_at is not null), 0) as pending_bytes,
      count(*) filter (where deleted_at is not null) as pending_files
    from attachment
  `);

  const topUsers = await db.execute<{
    user_id: string;
    name: string;
    email: string;
    bytes: string;
    files: string;
  }>(sql`
    select a.user_id, u.name, u.email,
           coalesce(sum(a.size_bytes), 0) as bytes,
           count(*) as files
    from attachment a
    join "user" u on u.id = a.user_id
    where a.deleted_at is null
    group by a.user_id, u.name, u.email
    order by sum(a.size_bytes) desc
    limit 10
  `);

  return {
    liveBytes: Number(totals?.live_bytes ?? 0),
    liveFileCount: Number(totals?.live_files ?? 0),
    pendingBytes: Number(totals?.pending_bytes ?? 0),
    pendingFileCount: Number(totals?.pending_files ?? 0),
    topUsers: topUsers.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      bytes: Number(row.bytes),
      files: Number(row.files),
    })),
  };
}

export interface DenialSummary {
  policyId: string | null;
  policyName: string;
  denials: number;
  usersAffected: number;
}

/**
 * Which limits are refusing runs, and how widely.
 *
 * Sustained denials across many people usually mean a limit is set too low
 * rather than that anyone is misbehaving; that distinction is the whole point
 * of reporting distinct users alongside the raw count.
 */
export async function denialSummary(days: number): Promise<DenialSummary[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await db.execute<{
    policy_id: string | null;
    policy_name: string;
    denials: string;
    users_affected: string;
  }>(sql`
    select policy_id, policy_name,
           sum(denial_count) as denials,
           count(distinct user_id) as users_affected
    from quota_denial
    where day >= ${since}
    group by policy_id, policy_name
    order by sum(denial_count) desc
  `);

  return rows.map((row) => ({
    policyId: row.policy_id,
    policyName: row.policy_name,
    denials: Number(row.denials),
    usersAffected: Number(row.users_affected),
  }));
}

export interface IdleModel {
  slug: string;
  displayName: string;
  labId: string | null;
}

/**
 * Models enabled in the catalog but unused over the range. Directly actionable
 * for a curated catalog: an enabled model nobody picks is a choice to revisit.
 */
export async function idleModels(days: number): Promise<IdleModel[]> {
  const rows = await db.execute<{ slug: string; display_name: string; lab_id: string | null }>(sql`
    select m.slug, m.display_name, m.lab_id
    from model m
    where m.enabled = true
      and not exists (
        select 1 from usage_event e
        where e.model_slug = m.slug and e.occurred_at >= ${rangeStart(days)}::timestamptz
      )
    order by m.display_name
  `);

  return rows.map((row) => ({
    slug: row.slug,
    displayName: row.display_name,
    labId: row.lab_id,
  }));
}

export async function usageRange(days: number): Promise<UsageReportRange> {
  return {
    days,
    timezone: await getDisplayTimezone(),
    // Beyond the event retention window the underlying rows are gone, so the
    // page must not imply the numbers are complete.
    exact: days <= EVENT_HISTORY_DAYS,
  };
}
