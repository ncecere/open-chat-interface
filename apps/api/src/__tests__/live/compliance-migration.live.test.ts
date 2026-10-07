import { readFileSync } from 'node:fs';
import { runMigrations, sql } from '@oci/db';
import { afterAll, describe, expect, it } from 'vitest';
import { liveS3Available } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

/**
 * Migration 0034 (compliance) on a real PostgreSQL database: audit entries
 * written before v0.9 are numbered in time order.
 */

const available = (await livePostgresAvailable()) && (await liveS3Available());

describe.skipIf(!available)('live migration 0034: numbering existing audit entries', () => {
  let live: LiveDatabase;
  afterAll(async () => {
    await live?.destroy();
  });

  it('numbers entries written before v0.9 in time order, then continues the sequence', async () => {
    live = await createLiveDatabase('compliance_migration');
    const organizationId = await seedOrganization(live.db);
    // Back to the shape before 0034 (the sequence goes with the column it belongs to).
    await live.db.execute(sql`alter table audit_log drop column seq`);
    const journal = JSON.parse(
      readFileSync(
        new URL('../../../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string; when: number }> };
    const entry = journal.entries.find((candidate) => candidate.tag === '0034_compliance');
    if (!entry) throw new Error('Migration 0034 is missing from the journal');
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where created_at >= ${entry.when}::bigint`);

    // Inserted out of time order, with a tie.
    const times = ['2026-03-01T00:00:02Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z'];
    for (const [index, at] of [...times, times[0]!].entries())
      await live.db.execute(sql`insert into audit_log (organization_id, action, created_at)
        values (${organizationId}, ${`before.${index}`}, ${at}::timestamptz)`);

    await runMigrations(live.db);
    const rows = await live.db.execute<{ seq: string; created_at: Date | string; id: string }>(
      sql`select seq, created_at, id from audit_log order by seq`,
    );
    const ordered = [...rows].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
        (a.id < b.id ? -1 : 1),
    );
    expect(rows.map((row) => row.id)).toEqual(ordered.map((row) => row.id));
    expect(rows.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4]);

    await live.db.execute(sql`insert into audit_log (organization_id, action)
      values (${organizationId}, 'after')`);
    const [latest] = await live.db.execute<{ seq: string }>(
      sql`select seq from audit_log where action = 'after'`,
    );
    expect(Number(latest!.seq)).toBe(5);
    // Applying it again changes nothing.
    await live.db.execute(sql`delete from drizzle.__drizzle_migrations
      where created_at >= ${entry.when}::bigint`);
    await runMigrations(live.db);
    const again = await live.db.execute<{ seq: string }>(
      sql`select seq from audit_log order by seq`,
    );
    expect(again.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4, 5]);
  });
});
