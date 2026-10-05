import { sql, USAGE_ROLLUP_BACKFILL } from '@oci/db';
import { db } from '../../db/index.js';
import { isBackgroundMigrationDone } from '../migrations/readiness.js';

type SQL = ReturnType<typeof sql.raw>;

/**
 * Where usage figures come from (docs/dev/database.md, "Usage rollups").
 *
 * `events` reads `usage_event` row by row, as every release before 0.11 did.
 * `rollups` reads the hourly rollups (migration 0040) plus the change log not
 * folded yet plus the events of any partial hour at the edges, in one
 * statement, and returns exactly the same figures. It is used once the
 * backfill `0.11.usage-rollups` has finished; before that the rollups lack
 * the events written before the upgrade.
 */
export type UsageSource = 'events' | 'rollups';

export async function usageSource(): Promise<UsageSource> {
  try {
    return (await isBackgroundMigrationDone(USAGE_ROLLUP_BACKFILL)) ? 'rollups' : 'events';
  } catch {
    // Cannot tell: the events are always right, only slower.
    return 'events';
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** The first whole UTC hour at or after an instant: rollups answer from there on. */
export function nextWholeHour(instant: Date): Date {
  return new Date(Math.ceil(instant.getTime() / HOUR_MS) * HOUR_MS);
}

export interface RollupRowsOptions {
  /** Inclusive lower bound, any instant. */
  start: Date;
  /**
   * `person` reads `usage_rollup_hour` (per person and model); `model` reads
   * `usage_rollup_model_hour`, much smaller, for figures not split by person
   * (its rows carry a null `user_id` and no budget amounts).
   */
  level: 'person' | 'model';
  /**
   * Set when the caller groups by local day: the hours a local midnight falls
   * inside (`straddlingHours`), read from the events instead, so every row
   * lies within one local day.
   */
  straddling?: string[];
  userId?: string;
  /** Only these models; empty or absent means every model. */
  modelSlugs?: string[];
  /** Leave out one event, as budget checks of a running reply do. */
  excludeEventId?: string;
}

/** One event as a row of the shape the rollups have. */
const EVENT_ROW = sql.raw(`
  e.occurred_at as at, e.user_id, e.model_slug,
  1::bigint as events,
  (case when e.pending then 0 else 1 end)::bigint as settled_events,
  (case when e.pending then 0 else e.message_count end)::bigint as messages,
  (case when e.pending then 0 else e.tokens_in end)::bigint as tokens_in,
  (case when e.pending then 0 else e.tokens_out end)::bigint as tokens_out,
  (case when e.pending then 0 else e.cost_micros end)::bigint as cost_micros,
  e.message_count::bigint as quota_messages,
  (e.tokens_in::bigint + e.tokens_out + e.reserved_tokens) as quota_tokens,
  (e.cost_micros + e.reserved_cost_micros) as quota_cost_micros`);

const PERSON_COLUMNS = sql.raw(`
  r.hour as at, r.user_id, r.model_slug, r.events, r.settled_events, r.messages,
  r.tokens_in, r.tokens_out, r.cost_micros, r.quota_messages, r.quota_tokens, r.quota_cost_micros`);

const MODEL_COLUMNS = sql.raw(`
  r.hour as at, null::text as user_id, r.model_slug, r.events, r.settled_events, r.messages,
  r.tokens_in, r.tokens_out, r.cost_micros,
  0::bigint as quota_messages, 0::bigint as quota_tokens, 0::bigint as quota_cost_micros`);

function filters(alias: 'r' | 'e', options: RollupRowsOptions): SQL {
  const parts: SQL[] = [];
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  if (options.userId !== undefined) parts.push(sql`${column('user_id')} = ${options.userId}`);
  if (options.modelSlugs?.length) {
    parts.push(
      sql`${column('model_slug')} in (${sql.join(
        options.modelSlugs.map((slug) => sql`${slug}`),
        sql`, `,
      )})`,
    );
  }
  return parts.length ? sql` and ${sql.join(parts, sql` and `)}` : sql``;
}

/**
 * Rows `(at, user_id, model_slug, events, settled_events, messages,
 * tokens_in, tokens_out, cost_micros, quota_messages, quota_tokens,
 * quota_cost_micros)` that sum to exactly what the events from `start` on
 * sum to, for use as `from (${rollupRows(...)}) src`. One statement, so the
 * rollups and the change log are read in one snapshot: a fold committing
 * meanwhile cannot make a change count twice or not at all.
 *
 * Sums over these rows equal sums over the events. A group exists among the
 * events exactly when its `events` (or, for settled figures,
 * `settled_events`) sum is above zero: rows can cancel out, for instance an
 * event deleted after it was folded, so callers filter groups with `having`
 * rather than counting rows.
 */
export function rollupRows(options: RollupRowsOptions): SQL {
  const start = options.start.toISOString();
  const boundary = nextWholeHour(options.start).toISOString();
  const person = options.level === 'person';
  const table = sql.raw(person ? 'usage_rollup_hour' : 'usage_rollup_model_hour');
  const columns = person ? PERSON_COLUMNS : MODEL_COLUMNS;
  const rollupFilters = filters('r', options);
  const eventFilters = filters('e', options);
  const exclude = options.excludeEventId;
  const straddling = options.straddling?.length ? options.straddling : null;
  // Passed as a constant array, so the planner knows how few hours it holds.
  const hours = straddling ? sql`${`{${straddling.join(',')}}`}::timestamptz[]` : null;
  const notStraddling = hours ? sql` and r.hour <> all(${hours})` : sql``;

  const branches: SQL[] = [
    sql`select ${columns} from ${table} r
        where r.hour >= ${boundary}::timestamptz${rollupFilters}${notStraddling}`,
    sql`select ${PERSON_COLUMNS} from usage_rollup_change r
        where r.hour >= ${boundary}::timestamptz${rollupFilters}${notStraddling}`,
    sql`select ${EVENT_ROW} from usage_event e
        where e.occurred_at >= ${start}::timestamptz and e.occurred_at < ${boundary}::timestamptz${eventFilters}${
          exclude === undefined ? sql`` : sql` and e.id <> ${exclude}`
        }`,
  ];
  if (hours) {
    branches.push(
      sql`select ${EVENT_ROW} from unnest(${hours}) as s(hour)
          join usage_event e on e.occurred_at >= s.hour and e.occurred_at < s.hour + interval '1 hour'
          where true${eventFilters}${exclude === undefined ? sql`` : sql` and e.id <> ${exclude}`}`,
    );
  }
  if (exclude !== undefined) {
    // The excluded event is in the rollups (or the change log) when it is
    // counted from a whole hour; take its amounts back out.
    branches.push(
      sql`select e.occurred_at as at, e.user_id, e.model_slug,
            -1::bigint, (case when e.pending then 0 else -1 end)::bigint,
            (case when e.pending then 0 else -e.message_count end)::bigint,
            (case when e.pending then 0 else -e.tokens_in end)::bigint,
            (case when e.pending then 0 else -e.tokens_out end)::bigint,
            (case when e.pending then 0 else -e.cost_micros end)::bigint,
            -e.message_count::bigint, -(e.tokens_in::bigint + e.tokens_out + e.reserved_tokens),
            -(e.cost_micros + e.reserved_cost_micros)
          from usage_event e
          where e.id = ${exclude} and e.in_rollup and e.occurred_at >= ${boundary}::timestamptz${eventFilters}${
            hours ? sql` and date_trunc('hour', e.occurred_at, 'UTC') <> all(${hours})` : sql``
          }`,
    );
  }
  return sql.join(branches, sql` union all `);
}

/**
 * The whole UTC hours from `start` on that a local midnight in `timezone`
 * falls inside: none for UTC or any zone a whole number of hours from it, one
 * a day for India or Nepal, for instance. Computed by PostgreSQL, with the same
 * time zone rules as the grouping, from candidates around each local midnight
 * up to two days past the newest hour (or now): kept when an hour's first and
 * last instants lie on different local days. A separate statement from the
 * report's, which is safe: only the time zone rules and the newest hour
 * matter.
 */
export async function straddlingHours(start: Date, timezone: string): Promise<string[]> {
  const boundary = nextWholeHour(start).toISOString();
  const rows = await db.execute<{ hour: string }>(sql`
    select distinct to_char(h.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as hour
    from generate_series(
      date_trunc('day', ${start.toISOString()}::timestamptz at time zone ${timezone}),
      greatest(
        now(),
        (select max(hour) from usage_rollup_model_hour),
        (select max(hour) from usage_rollup_change)
      ) at time zone ${timezone} + interval '2 days',
      interval '1 day'
    ) as d(local_day)
    cross join lateral generate_series(
      date_trunc('hour', d.local_day at time zone ${timezone}, 'UTC') - interval '2 hours',
      date_trunc('hour', d.local_day at time zone ${timezone}, 'UTC') + interval '2 hours',
      interval '1 hour'
    ) as h(hour)
    where h.hour >= ${boundary}::timestamptz
      and date_trunc('day', h.hour at time zone ${timezone})
        <> date_trunc('day', (h.hour + interval '59 minutes 59.999999 seconds') at time zone ${timezone})
    order by 1
  `);
  return rows.map((row) => row.hour);
}
