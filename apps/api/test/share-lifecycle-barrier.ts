import { sql } from '@oci/db';
import { expect, vi } from 'vitest';
import type { ShareLifecycleFixture } from './share-lifecycle.js';

/** Pause an actual service write while it holds its thread lock. Test DB only. */
export async function shareLifecycleBarrier(
  fixture: ShareLifecycleFixture,
  operation: 'create' | 'delete',
) {
  const owner = await fixture.client.reserve();
  await owner`select pg_advisory_lock(829174)`;
  await fixture.db.execute(sql`
    create function pause_share_lifecycle() returns trigger language plpgsql as $$
    begin
      perform pg_advisory_xact_lock(829174);
      return new;
    end $$
  `);
  if (operation === 'create') {
    await fixture.db.execute(sql`create trigger pause_share_lifecycle before insert on share_link
      for each row execute function pause_share_lifecycle()`);
  } else {
    await fixture.db.execute(sql`create trigger pause_share_lifecycle before update on thread
      for each row when (new.deleted_at is not null)
      execute function pause_share_lifecycle()`);
  }

  let released = false;
  return {
    async waitForWriter() {
      await vi.waitFor(async () => {
        const [row] = await fixture.db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event = 'advisory'
        `);
        expect(row?.count).toBe(1);
      });
    },
    async waitForThreadWaiters(count: number) {
      await vi.waitFor(async () => {
        const [row] = await fixture.db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and wait_event in ('transactionid', 'tuple')
        `);
        expect(row?.count).toBeGreaterThanOrEqual(count);
      });
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await owner`select pg_advisory_unlock(829174)`;
      } finally {
        owner.release();
      }
    },
    async destroy() {
      if (operation === 'create') {
        await fixture.db.execute(sql`drop trigger pause_share_lifecycle on share_link`);
      } else {
        await fixture.db.execute(sql`drop trigger pause_share_lifecycle on thread`);
      }
      await fixture.db.execute(sql`drop function pause_share_lifecycle()`);
    },
  };
}
