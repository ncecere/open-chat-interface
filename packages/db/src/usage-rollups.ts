import type postgres from 'postgres';

/**
 * Usage rollups (migration 0040; docs/dev/database.md, "Usage rollups").
 *
 * Statement triggers on `usage_event` append differences to
 * `usage_rollup_change` in the writer's transaction. Folding moves them into
 * `usage_rollup_hour` (per UTC hour, person and model) and
 * `usage_rollup_model_hour` (per UTC hour and model). Readers add whatever is
 * still in the change log in the same statement, so folding only changes how
 * fast they are, never what they return.
 */

/** The background migration that adds events written before migration 0040. */
export const USAGE_ROLLUP_BACKFILL = '0.11.usage-rollups';

/** Changes folded per statement. */
export const USAGE_ROLLUP_FOLD_BATCH = 5_000;

/**
 * Taken with `pg_try_advisory_xact_lock`, so only one transaction folds at a
 * time (the fold job, or a backfill batch helping it) and none waits for
 * another. Arbitrary, fixed, and distinct from OCI's other advisory keys.
 */
export const USAGE_ROLLUP_FOLD_LOCK_KEY = 7_311_890_418_002;

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface FoldResult {
  /** Change rows folded; 0 when another transaction was folding. */
  changes: number;
  /** False when another transaction holds the fold lock. */
  locked: boolean;
}

/**
 * Folds up to `limit` changes, oldest first, inside the caller's transaction
 * (`tx` must be one: the delete, the two upserts and the clean-up commit or
 * roll back together, so a crash or a retry never loses or repeats a change).
 *
 * Upserts are sorted by key, so even two folds could not deadlock; the lock
 * means there is only one.
 */
export async function foldUsageRollupChanges(
  tx: postgres.TransactionSql,
  limit: number = USAGE_ROLLUP_FOLD_BATCH,
): Promise<FoldResult> {
  const [lock] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(${USAGE_ROLLUP_FOLD_LOCK_KEY}::bigint) as locked
  `;
  if (!lock?.locked) return { changes: 0, locked: false };
  const [row] = await tx<{ changes: number; empty_people: unknown[]; empty_models: unknown[] }[]>`
    with batch as (
      delete from usage_rollup_change
      where id in (select id from usage_rollup_change order by id limit ${limit})
      returning *
    ),
    per_person as (
      insert into usage_rollup_hour as r (hour, user_id, model_slug, events, settled_events,
        messages, tokens_in, tokens_out, cost_micros, quota_messages, quota_tokens, quota_cost_micros)
      select hour, user_id, model_slug, sum(events), sum(settled_events), sum(messages),
        sum(tokens_in), sum(tokens_out), sum(cost_micros), sum(quota_messages),
        sum(quota_tokens), sum(quota_cost_micros)
      from batch
      group by hour, user_id, model_slug
      order by hour, user_id, model_slug
      on conflict (hour, user_id, model_slug) do update set
        events = r.events + excluded.events,
        settled_events = r.settled_events + excluded.settled_events,
        messages = r.messages + excluded.messages,
        tokens_in = r.tokens_in + excluded.tokens_in,
        tokens_out = r.tokens_out + excluded.tokens_out,
        cost_micros = r.cost_micros + excluded.cost_micros,
        quota_messages = r.quota_messages + excluded.quota_messages,
        quota_tokens = r.quota_tokens + excluded.quota_tokens,
        quota_cost_micros = r.quota_cost_micros + excluded.quota_cost_micros,
        updated_at = now()
      returning r.hour, r.user_id, r.model_slug,
        (r.events = 0 and r.settled_events = 0 and r.messages = 0 and r.tokens_in = 0
          and r.tokens_out = 0 and r.cost_micros = 0 and r.quota_messages = 0
          and r.quota_tokens = 0 and r.quota_cost_micros = 0) as empty
    ),
    per_model as (
      insert into usage_rollup_model_hour as r (hour, model_slug, events, settled_events,
        messages, tokens_in, tokens_out, cost_micros)
      select hour, model_slug, sum(events), sum(settled_events), sum(messages),
        sum(tokens_in), sum(tokens_out), sum(cost_micros)
      from batch
      group by hour, model_slug
      order by hour, model_slug
      on conflict (hour, model_slug) do update set
        events = r.events + excluded.events,
        settled_events = r.settled_events + excluded.settled_events,
        messages = r.messages + excluded.messages,
        tokens_in = r.tokens_in + excluded.tokens_in,
        tokens_out = r.tokens_out + excluded.tokens_out,
        cost_micros = r.cost_micros + excluded.cost_micros,
        updated_at = now()
      returning r.hour, r.model_slug,
        (r.events = 0 and r.settled_events = 0 and r.messages = 0 and r.tokens_in = 0
          and r.tokens_out = 0 and r.cost_micros = 0) as empty
    )
    select (select count(*) from batch)::int as changes,
      (select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'user_id', user_id, 'model_slug', model_slug)), '[]')
         from per_person where empty) as empty_people,
      (select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'model_slug', model_slug)), '[]')
         from per_model where empty) as empty_models
  `;
  const changes = row?.changes ?? 0;
  // Rows a change left at zero (an account's usage moved to Deleted accounts,
  // events pruned) hold nothing; delete them so a deleted person's id does not
  // linger. This transaction upserted, and so locked, each of them.
  if (row && row.empty_people.length > 0) {
    await tx`
      delete from usage_rollup_hour r
      using jsonb_to_recordset(${JSON.stringify(row.empty_people)}::jsonb)
        as k(hour timestamptz, user_id text, model_slug text)
      where r.hour = k.hour and r.user_id is not distinct from k.user_id
        and r.model_slug = k.model_slug and r.events = 0 and r.settled_events = 0
        and r.messages = 0 and r.tokens_in = 0 and r.tokens_out = 0 and r.cost_micros = 0
        and r.quota_messages = 0 and r.quota_tokens = 0 and r.quota_cost_micros = 0
    `;
  }
  if (row && row.empty_models.length > 0) {
    await tx`
      delete from usage_rollup_model_hour r
      using jsonb_to_recordset(${JSON.stringify(row.empty_models)}::jsonb)
        as k(hour timestamptz, model_slug text)
      where r.hour = k.hour and r.model_slug = k.model_slug and r.events = 0
        and r.settled_events = 0 and r.messages = 0 and r.tokens_in = 0 and r.tokens_out = 0
        and r.cost_micros = 0
    `;
  }
  return { changes, locked: true };
}

/** Folds until the change log is empty, the time budget is spent, or another fold holds the lock. */
export async function foldAllUsageRollupChanges(
  client: postgres.Sql,
  options: { budgetMs?: number; limit?: number; shouldStop?: () => boolean } = {},
): Promise<number> {
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  const limit = options.limit ?? USAGE_ROLLUP_FOLD_BATCH;
  let total = 0;
  for (;;) {
    const result = (await client.begin((tx) => foldUsageRollupChanges(tx, limit))) as FoldResult;
    total += result.changes;
    if (!result.locked || result.changes < limit || Date.now() >= deadline) return total;
    if (options.shouldStop?.()) return total;
  }
}

/** Rows waiting in the change log (an estimate when large), for System health and metrics. */
export async function usageRollupBacklog(client: Queryable): Promise<number> {
  const [row] = await client<{ backlog: number }[]>`
    select count(*)::int as backlog from (select 1 from usage_rollup_change limit 1000000) c
  `;
  return row?.backlog ?? 0;
}
