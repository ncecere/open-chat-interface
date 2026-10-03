import { randomUUID } from 'node:crypto';
import type { Database } from '@oci/db';
import { sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Exercises quota SQL against a real Postgres with the real migrations applied.
 * The mocked suites assert policy logic; these assert that the schema,
 * constraints, and generated SQL actually behave as intended.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: quota reservations', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('quota');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function insertEvent(overrides: {
    pending?: boolean;
    messages?: number;
    costMicros?: number;
    occurredAt?: Date;
  }): Promise<void> {
    await db.execute(sql`
      insert into usage_event
        (organization_id, user_id, model_slug, occurred_at, message_count, tokens_in, tokens_out, cost_micros, pending)
      values (
        ${organizationId}, ${userId}, 'test-model',
        ${(overrides.occurredAt ?? new Date()).toISOString()}::timestamptz,
        ${overrides.messages ?? 1}, 0, 0,
        ${String(overrides.costMicros ?? 0)}::bigint, ${overrides.pending ?? false}
      )
    `);
  }

  async function totals(cutoff: Date, liveCutoff: Date) {
    const rows = await db.execute<{ messages: string; cost: string }>(sql`
      select
        coalesce(sum(message_count), 0)::bigint as messages,
        coalesce(sum(cost_micros), 0)::bigint as cost
      from usage_event
      where user_id = ${userId}
        and occurred_at >= ${cutoff.toISOString()}::timestamptz
        and (pending = false or occurred_at >= ${liveCutoff.toISOString()}::timestamptz)
    `);
    return { messages: Number(rows[0]?.messages ?? 0), cost: Number(rows[0]?.cost ?? 0) };
  }

  it('counts a live pending reservation toward the window', async () => {
    await insertEvent({ pending: true, messages: 1 });

    const window = await totals(new Date(Date.now() - 3_600_000), new Date(Date.now() - 900_000));
    expect(window.messages).toBe(1);
  });

  it('stops counting a reservation once it ages past the TTL', async () => {
    // Abandoned by a crashed process 30 minutes ago, beyond the 15-minute TTL.
    await insertEvent({
      pending: true,
      messages: 1,
      occurredAt: new Date(Date.now() - 30 * 60_000),
    });

    const window = await totals(new Date(Date.now() - 3_600_000), new Date(Date.now() - 900_000));
    // Only the still-live reservation from the previous test counts.
    expect(window.messages).toBe(1);
  });

  it('sums bigint cost without overflowing or losing precision', async () => {
    const isolated = await seedUser(db, organizationId);
    // Well beyond a 32-bit integer, which is why the column is bigint.
    const large = 9_000_000_000;

    await db.execute(sql`
      insert into usage_event
        (organization_id, user_id, model_slug, message_count, tokens_in, tokens_out, cost_micros, pending)
      values (${organizationId}, ${isolated}, 'm', 1, 0, 0, ${String(large)}::bigint, false),
             (${organizationId}, ${isolated}, 'm', 1, 0, 0, ${String(large)}::bigint, false)
    `);

    const rows = await db.execute<{ cost: string }>(sql`
      select coalesce(sum(cost_micros), 0)::bigint as cost
      from usage_event where user_id = ${isolated}
    `);
    expect(Number(rows[0]?.cost)).toBe(large * 2);
  });

  it('enforces the rollup unique constraint that prevents duplicate day rows', async () => {
    const day = '2026-01-01';
    const insertRollup = () =>
      db.execute(sql`
        insert into usage_record (organization_id, user_id, model_slug, day, message_count)
        values (${organizationId}, ${userId}, 'dup-model', ${day}, 1)
      `);

    await insertRollup();
    // The migration added this constraint precisely to stop concurrent streams
    // racing into duplicate rollups.
    await expect(insertRollup()).rejects.toThrow();
  });

  it('keeps usage rows without the person when a user is deleted', async () => {
    const doomed = await seedUser(db, organizationId);
    const [event] = await db.execute<{ id: string }>(sql`
      insert into usage_event (organization_id, user_id, model_slug, message_count, tokens_in, tokens_out, cost_micros)
      values (${organizationId}, ${doomed}, 'kept-on-delete', 1, 0, 0, 0)
      returning id
    `);
    await db.execute(sql`
      insert into usage_record (organization_id, user_id, model_slug, day, message_count)
      values (${organizationId}, ${doomed}, 'kept-on-delete', '2026-01-02', 1)
    `);

    await db.execute(sql`delete from "user" where id = ${doomed}`);

    const rows = await db.execute<{ user_id: string | null }>(
      sql`select user_id from usage_event where id = ${event!.id}`,
    );
    expect(rows).toEqual([{ user_id: null }]);
    const rollups = await db.execute<{ user_id: string | null }>(
      sql`select user_id from usage_record where model_slug = 'kept-on-delete'`,
    );
    expect(rollups).toEqual([{ user_id: null }]);
  });
});

describe.skipIf(!available)('live Postgres: quota policy constraints', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('policy');
    db = live.db;
    organizationId = await seedOrganization(db);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  it('refuses two policies with the same name in one organization', async () => {
    const insertPolicy = () =>
      db.execute(sql`
        insert into quota_policy (organization_id, name, metric, limit_value, window_kind, timezone)
        values (${organizationId}, 'Daily cap', 'messages', 100, 'daily', 'UTC')
      `);

    await insertPolicy();
    await expect(insertPolicy()).rejects.toThrow();
  });

  it('removes role assignments when a policy is deleted', async () => {
    const [policy] = await db.execute<{ id: string }>(sql`
      insert into quota_policy (organization_id, name, metric, limit_value, window_kind, timezone)
      values (${organizationId}, ${`Policy ${randomUUID().slice(0, 6)}`}, 'tokens', 500, 'rolling', 'UTC')
      returning id
    `);

    await db.execute(
      sql`insert into quota_policy_role (policy_id, role) values (${policy?.id}, 'user')`,
    );
    await db.execute(sql`delete from quota_policy where id = ${policy?.id}`);

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from quota_policy_role where policy_id = ${policy?.id}`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('stores a budget limit large enough for real dollar amounts', async () => {
    // $10,000 in micro-dollars overflows a 32-bit integer column.
    const tenThousandDollars = 10_000 * 1_000_000;

    const [row] = await db.execute<{ limit_value: string }>(sql`
      insert into quota_policy (organization_id, name, metric, limit_value, window_kind, timezone)
      values (${organizationId}, 'Big budget', 'cost', ${String(tenThousandDollars)}::bigint, 'monthly', 'UTC')
      returning limit_value
    `);
    expect(Number(row?.limit_value)).toBe(tenThousandDollars);
  });
});
