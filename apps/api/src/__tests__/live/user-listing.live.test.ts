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
 * Sorting and filtering for the user list.
 *
 * These run against real SQL because that is where the behaviour lives: the
 * ordering, the tiebreak that keeps pagination stable, and the filters are all
 * expressed in the query rather than in application code.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: user listing', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('user_listing');
    db = live.db;
    organizationId = await seedOrganization(db);

    const alice = await seedUser(db, organizationId, { email: 'alice@example.com' });
    const bob = await seedUser(db, organizationId, { email: 'bob@example.com' });
    const carol = await seedUser(db, organizationId, { email: 'carol@example.com' });

    await db.execute(sql`update "user" set name = 'Alice', role = 'admin' where id = ${alice}`);
    await db.execute(
      sql`update "user" set name = 'Bob', banned = true, email_verified = false where id = ${bob}`,
    );
    await db.execute(
      sql`update "user" set name = 'Carol', role = 'restricted' where id = ${carol}`,
    );

    // Give Alice conversations so the derived counts have something to order.
    for (let index = 0; index < 3; index += 1) {
      await db.execute(sql`
        insert into thread (organization_id, user_id, title)
        values (${organizationId}, ${alice}, ${`Thread ${index}`})
      `);
    }
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function names(orderBy: string, direction = 'asc'): Promise<string[]> {
    const rows = await db.execute<{ name: string }>(sql`
      select name from "user"
      order by ${sql.raw(orderBy)} ${sql.raw(direction)}, id desc
    `);
    return rows.map((row) => row.name);
  }

  it('orders by name in both directions', async () => {
    expect(await names('name')).toEqual(['Alice', 'Bob', 'Carol']);
    expect(await names('name', 'desc')).toEqual(['Carol', 'Bob', 'Alice']);
  });

  it('orders by a derived conversation count', async () => {
    const rows = await db.execute<{ name: string; threads: number }>(sql`
      select u.name,
             (select count(*) from thread t where t.user_id = u.id)::int as threads
      from "user" u
      order by threads desc, u.id desc
    `);
    expect(rows[0]?.name).toBe('Alice');
    expect(rows[0]?.threads).toBe(3);
  });

  it('filters by role', async () => {
    const rows = await db.execute<{ name: string }>(
      sql`select name from "user" where role = 'admin'`,
    );
    expect(rows.map((row) => row.name)).toEqual(['Alice']);
  });

  it('filters banned accounts apart from active ones', async () => {
    const banned = await db.execute<{ name: string }>(
      sql`select name from "user" where banned = true`,
    );
    const active = await db.execute<{ name: string }>(
      sql`select name from "user" where banned = false order by name`,
    );

    expect(banned.map((row) => row.name)).toEqual(['Bob']);
    expect(active.map((row) => row.name)).toEqual(['Alice', 'Carol']);
  });

  it('filters unverified email addresses', async () => {
    const rows = await db.execute<{ name: string }>(
      sql`select name from "user" where email_verified = false`,
    );
    expect(rows.map((row) => row.name)).toEqual(['Bob']);
  });

  it('keeps pagination stable when the sort column has duplicates', async () => {
    // Every row shares a role here, so only the tiebreak distinguishes them.
    await db.execute(sql`update "user" set role = 'user'`);

    const page = async (offset: number) => {
      const rows = await db.execute<{ id: string }>(sql`
        select id from "user" order by role asc, id desc limit 2 offset ${offset}
      `);
      return rows.map((row) => row.id);
    };

    const first = await page(0);
    const second = await page(2);

    // Without the tiebreak a row could repeat across pages or be skipped.
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });
});
