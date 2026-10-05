import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { type Bounded, type ReportOptions, rangeStart, reportSource } from './common.js';
import { rollupRows } from './source.js';

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
export async function denialSummary(days: number, limit = 25): Promise<Bounded<DenialSummary>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Grows with policies times people, so it is capped like the others.
  const [counted] = await db.execute<{ total: string }>(sql`
    select count(distinct policy_id) as total from quota_denial where day >= ${since}
  `);

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
    limit ${limit}
  `);

  return {
    entries: rows.map((row) => ({
      policyId: row.policy_id,
      policyName: row.policy_name,
      denials: Number(row.denials),
      usersAffected: Number(row.users_affected),
    })),
    totalCount: Number(counted?.total ?? 0),
  };
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
export async function idleModels(
  days: number,
  limit = 30,
  options: ReportOptions = {},
): Promise<Bounded<IdleModel>> {
  const start = rangeStart(days, options.now);
  // Any event counts as use, a reply still being written included.
  const used =
    (await reportSource(options)) === 'rollups'
      ? sql`m.slug in (
          select u.model_slug from (${rollupRows({ start: new Date(start), level: 'model' })}) u
          group by u.model_slug
          having sum(u.events) > 0
        )`
      : sql`exists (
          select 1 from usage_event e
          where e.model_slug = m.slug and e.occurred_at >= ${start}::timestamptz
        )`;

  const rows = await db.execute<{
    slug: string;
    display_name: string;
    lab_id: string | null;
    total: string;
  }>(sql`
    with idle as (
      select m.slug, m.display_name, m.lab_id
      from model m
      where m.enabled = true and not (${used})
    )
    select slug, display_name, lab_id, (select count(*) from idle) as total
    from idle
    order by display_name, slug
    limit ${limit}
  `);

  return {
    entries: rows.map((row) => ({
      slug: row.slug,
      displayName: row.display_name,
      labId: row.lab_id,
    })),
    totalCount: rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0,
  };
}
