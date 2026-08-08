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
 * Per-user quota overrides against real migrations.
 *
 * Expiry is the part worth proving here. It is filtered when a limit is read
 * rather than swept by a job, so an override has to stop applying at the exact
 * moment it lapses. A mocked query chain cannot demonstrate that, because the
 * behavior lives in the SQL predicate itself.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: quota policy overrides', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;
  let otherUserId: string;
  let policyId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('quota_overrides');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId, { email: 'heavy@example.com' });
    otherUserId = await seedUser(db, organizationId, { email: 'normal@example.com' });

    const [policy] = await db.execute<{ id: string }>(sql`
      insert into quota_policy (organization_id, name, metric, limit_value, window_kind, timezone)
      values (${organizationId}, 'Daily messages', 'messages', 100, 'daily', 'UTC')
      returning id
    `);
    if (!policy) throw new Error('Failed to create policy');
    policyId = policy.id;

    await db.execute(sql`
      insert into quota_policy_role (policy_id, role) values (${policyId}, 'user')
    `);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  /** Mirrors the predicate enforcement uses when it reads a limit. */
  async function effectiveLimit(forUser: string): Promise<number> {
    const [row] = await db.execute<{ limit_value: string }>(sql`
      select coalesce(o.limit_value, p.limit_value) as limit_value
      from quota_policy p
      left join quota_policy_override o
        on o.policy_id = p.id
       and o.user_id = ${forUser}
       and (o.expires_at is null or o.expires_at > now())
      where p.id = ${policyId}
    `);
    return Number(row?.limit_value);
  }

  it('leaves the role limit in place when no override exists', async () => {
    expect(await effectiveLimit(userId)).toBe(100);
  });

  it('raises the limit for the person it was granted to', async () => {
    await db.execute(sql`
      insert into quota_policy_override (policy_id, user_id, limit_value, reason)
      values (${policyId}, ${userId}, 500, 'Research workload')
    `);

    expect(await effectiveLimit(userId)).toBe(500);
  });

  it('leaves everyone else on the role limit', async () => {
    // An override is for one person; it must not leak to their peers.
    expect(await effectiveLimit(otherUserId)).toBe(100);
  });

  it('stops applying the moment it lapses, without waiting for cleanup', async () => {
    await db.execute(sql`
      update quota_policy_override
      set expires_at = now() - interval '1 second'
      where policy_id = ${policyId} and user_id = ${userId}
    `);

    // The row still exists; only the predicate has stopped matching it.
    const [remaining] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_policy_override where user_id = ${userId}`,
    );
    expect(Number(remaining?.count)).toBe(1);
    expect(await effectiveLimit(userId)).toBe(100);
  });

  it('still applies while the expiry is in the future', async () => {
    await db.execute(sql`
      update quota_policy_override
      set expires_at = now() + interval '1 hour'
      where policy_id = ${policyId} and user_id = ${userId}
    `);

    expect(await effectiveLimit(userId)).toBe(500);
  });

  it('keeps one override per policy per person', async () => {
    await db.execute(sql`
      insert into quota_policy_override (policy_id, user_id, limit_value)
      values (${policyId}, ${userId}, 750)
      on conflict (policy_id, user_id) do update set limit_value = 750, expires_at = null
    `);

    const [rows] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_policy_override
          where policy_id = ${policyId} and user_id = ${userId}`,
    );
    // Editing replaces, so a user's limit always has exactly one source.
    expect(Number(rows?.count)).toBe(1);
    expect(await effectiveLimit(userId)).toBe(750);
  });

  it('disappears with the policy it adjusts', async () => {
    const [policy] = await db.execute<{ id: string }>(sql`
      insert into quota_policy (organization_id, name, metric, limit_value, window_kind, timezone)
      values (${organizationId}, 'Temporary policy', 'messages', 10, 'daily', 'UTC')
      returning id
    `);
    if (!policy) throw new Error('Failed to create policy');

    await db.execute(sql`
      insert into quota_policy_override (policy_id, user_id, limit_value)
      values (${policy.id}, ${userId}, 50)
    `);
    await db.execute(sql`delete from quota_policy where id = ${policy.id}`);

    const [orphans] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_policy_override where policy_id = ${policy.id}`,
    );
    expect(Number(orphans?.count)).toBe(0);
  });

  it('disappears with the person it was granted to', async () => {
    const doomed = await seedUser(db, organizationId, { email: 'leaving@example.com' });
    await db.execute(sql`
      insert into quota_policy_override (policy_id, user_id, limit_value)
      values (${policyId}, ${doomed}, 900)
    `);

    await db.execute(sql`delete from "user" where id = ${doomed}`);

    const [orphans] = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_policy_override where user_id = ${doomed}`,
    );
    expect(Number(orphans?.count)).toBe(0);
  });
});
