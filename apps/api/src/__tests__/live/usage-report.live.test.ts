import { type Database, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Usage reporting against real migrations.
 *
 * The behavior worth proving is timezone bucketing: an event's day depends on
 * the zone it is read in, and the queries do that with `at time zone`. A
 * mocked chain cannot demonstrate a boundary shift, because the shifting
 * happens inside Postgres.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: usage reporting', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('usage_report');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId, { email: 'heavy@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function addEvent(occurredAt: string, costMicros: number, modelSlug = 'model-a') {
    await db.execute(sql`
      insert into usage_event
        (organization_id, user_id, model_slug, occurred_at, message_count, tokens_in, tokens_out, cost_micros, pending)
      values
        (${organizationId}, ${userId}, ${modelSlug}, ${occurredAt}::timestamptz, 1, 10, 20, ${costMicros}, false)
    `);
  }

  async function daysIn(timezone: string): Promise<string[]> {
    const rows = await db.execute<{ day: string }>(sql`
      select to_char(date_trunc('day', occurred_at at time zone ${timezone}), 'YYYY-MM-DD') as day
      from usage_event
      group by 1
      order by 1
    `);
    return rows.map((row) => row.day);
  }

  it('buckets an event into the day of the zone it is read in', async () => {
    // 02:30 UTC is still the previous evening in New York.
    await addEvent('2026-03-10T02:30:00Z', 1_000);

    expect(await daysIn('UTC')).toEqual(['2026-03-10']);
    expect(await daysIn('America/New_York')).toEqual(['2026-03-09']);
  });

  it('keeps events on the same day when the boundary does not move them', async () => {
    await addEvent('2026-03-10T18:00:00Z', 2_000);

    // Both land on the 10th locally, so the two zones now agree on that day.
    expect(await daysIn('America/New_York')).toEqual(['2026-03-09', '2026-03-10']);
  });

  it('excludes in-flight reservations from settled totals', async () => {
    await db.execute(sql`
      insert into usage_event
        (organization_id, user_id, model_slug, occurred_at, message_count, cost_micros, reserved_cost_micros, pending)
      values
        (${organizationId}, ${userId}, 'model-a', now(), 1, 0, 500_000, true)
    `);

    const [row] = await db.execute<{ total: string }>(
      sql`select coalesce(sum(cost_micros), 0) as total from usage_event where pending = false`,
    );
    // A reservation is not spend; counting it would overstate the report.
    expect(Number(row?.total)).toBe(3_000);
  });

  it('counts denials per policy without one row per refusal', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.execute(sql`
        insert into quota_denial
          (organization_id, user_id, policy_id, policy_name, model_slug, day, denial_count)
        values
          (${organizationId}, ${userId}, 'policy-1', 'Anthropic models', 'model-a', '2026-03-10', 1)
        on conflict (user_id, policy_id, model_slug, day)
        do update set denial_count = quota_denial.denial_count + 1
      `);
    }

    const [row] = await db.execute<{ count: string; denials: string }>(sql`
      select count(*)::bigint as count, sum(denial_count) as denials from quota_denial
    `);
    // Rejections are cheap to produce, so they must roll up rather than grow
    // the table without bound.
    expect(Number(row?.count)).toBe(1);
    expect(Number(row?.denials)).toBe(3);
  });

  it('keeps denial history after the policy that caused it is deleted', async () => {
    // The policy name is snapshotted precisely so removing a bad limit does
    // not erase the evidence that it was refusing people.
    await db.execute(sql`delete from quota_policy where id = 'policy-1'`);

    const [row] = await db.execute<{ policy_name: string }>(
      sql`select policy_name from quota_denial limit 1`,
    );
    expect(row?.policy_name).toBe('Anthropic models');
  });

  it('keeps denials without the person they belonged to', async () => {
    const doomed = await seedUser(db, organizationId, { email: 'leaving@example.com' });
    await db.execute(sql`
      insert into quota_denial
        (organization_id, user_id, policy_id, policy_name, model_slug, day, denial_count)
      values (${organizationId}, ${doomed}, 'policy-2', 'Daily messages', 'model-a', '2026-03-11', 5)
    `);

    await db.execute(sql`delete from "user" where id = ${doomed}`);

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_denial where user_id = ${doomed}`,
    );
    expect(Number(row?.count)).toBe(0);
    // The refusals still count towards the limit's history (Usage, Limits tab).
    const kept = await db.execute<{ user_id: string | null; denial_count: number }>(
      sql`select user_id, denial_count from quota_denial where policy_id = 'policy-2'`,
    );
    expect(kept).toEqual([{ user_id: null, denial_count: 5 }]);
  });
});
