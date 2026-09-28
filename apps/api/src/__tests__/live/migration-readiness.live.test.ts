import { migrationsApplied, sql } from '@oci/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: required migration readiness', () => {
  let live: LiveDatabase;
  beforeEach(async () => {
    live = await createLiveDatabase('migration_readiness');
  });
  afterEach(async () => {
    await live?.destroy();
  });

  it('accepts the current recorded migration set', async () => {
    expect(await migrationsApplied(live.db)).toBe(true);
  });
  it('still accepts its required marker when an additional newer marker exists', async () => {
    await live.db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at)
      select 'fixture-only-newer-marker', max(created_at) + 86400000 from drizzle.__drizzle_migrations`);
    expect(await migrationsApplied(live.db)).toBe(true);
  });
  it('rejects a database with no migration history table', async () => {
    await live.db.execute(sql`drop schema drizzle cascade`);
    expect(await migrationsApplied(live.db)).toBe(false);
  });
  it('rejects stale history even though earlier migration records exist', async () => {
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where id = (select id from drizzle.__drizzle_migrations order by created_at desc limit 1)`);
    const [remaining] = await live.db.execute<{ count: number }>(sql`
      select count(*)::integer as count from drizzle.__drizzle_migrations`);
    expect(remaining!.count).toBeGreaterThan(0);
    expect(await migrationsApplied(live.db)).toBe(false);
  });
  it('does not mistake an unrelated future marker for the missing required migration', async () => {
    await live.db.execute(sql`update drizzle.__drizzle_migrations
      set created_at = created_at + 86400000
      where id = (select id from drizzle.__drizzle_migrations order by created_at desc limit 1)`);
    expect(await migrationsApplied(live.db)).toBe(false);
  });
});
