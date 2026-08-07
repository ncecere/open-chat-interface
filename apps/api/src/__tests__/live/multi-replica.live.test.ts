import { randomUUID } from 'node:crypto';
import { type Database, inArray, runMigrationsWithLock, schema, seedDatabase, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Behaviour that only matters when more than one API replica runs. These races
 * cannot be reproduced against a mock: they depend on real advisory locks and
 * on Postgres arbitrating concurrent writers.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live: concurrent migrations', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('replica-migrate');
  });

  afterAll(async () => {
    await live?.destroy();
  });

  it('serializes replicas migrating the same database at once', async () => {
    const url = live.connectionString;

    // Three replicas booting together. The advisory lock must let exactly one
    // migrate at a time; without it drizzle races itself and errors.
    const results = await Promise.allSettled([
      runMigrationsWithLock(url),
      runMigrationsWithLock(url),
      runMigrationsWithLock(url),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const rows = await live.db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from drizzle.__drizzle_migrations`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('leaves a single organization when replicas seed concurrently', async () => {
    await Promise.all([seedDatabase(live.db), seedDatabase(live.db), seedDatabase(live.db)]);

    const rows = await live.db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from organization`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});

describe.skipIf(!available)('live: concurrent reservation sweeps', () => {
  let live: LiveDatabase;
  let db: Database;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('replica-sweep');
    db = live.db;
    organizationId = await seedOrganization(db);
    userId = await seedUser(db, organizationId);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  async function seedAbandoned(count: number): Promise<void> {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    for (let index = 0; index < count; index += 1) {
      await db.execute(sql`
        insert into usage_event
          (organization_id, user_id, model_slug, occurred_at, message_count, tokens_in, tokens_out, cost_micros, pending)
        values (${organizationId}, ${userId}, ${`m-${randomUUID().slice(0, 6)}`},
                ${stale}::timestamptz, 1, 10, 20, ${'30'}::bigint, true)
      `);
    }
  }

  /** Mirrors the service's claim-and-settle so the test needs no app wiring. */
  async function sweep(): Promise<number> {
    return db.transaction(async (tx) => {
      const claimed = await tx.execute<{ id: string }>(sql`
        select id from usage_event
        where pending = true and occurred_at < ${new Date(Date.now() - 15 * 60_000).toISOString()}::timestamptz
        for update skip locked
      `);
      if (claimed.length === 0) return 0;

      await tx
        .update(schema.usageEvent)
        .set({ pending: false })
        .where(
          inArray(
            schema.usageEvent.id,
            claimed.map((row) => row.id),
          ),
        );
      return claimed.length;
    });
  }

  it('claims each abandoned reservation exactly once across replicas', async () => {
    await seedAbandoned(9);

    // skip locked is what lets replicas sweep in parallel without either
    // blocking on the other or settling the same row twice.
    const counts = await Promise.all([sweep(), sweep(), sweep()]);

    expect(counts.reduce((total, value) => total + value, 0)).toBe(9);

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from usage_event where pending`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
