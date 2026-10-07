import { eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoAdmin, demoNow, seedDemoData } from '../../../../../packages/db/src/seed-demo.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * The demo seed (#116): "Alex" belonged to whichever administrator the
 * database returned first, every seeded time was pinned to 2026-06-15 (out
 * of the Usage page's 90 days within months), and an audit entry named a
 * policy that does not exist.
 */
const available = await livePostgresAvailable();

describe('the demo seed’s clock', () => {
  it('is 14:30 UTC on the day it runs, or DEMO_NOW when set', () => {
    const today = new Date('2026-10-05T09:12:00Z');
    expect(demoNow({}, today).toISOString()).toBe('2026-10-05T14:30:00.000Z');
    expect(demoNow({ DEMO_NOW: '2026-06-15T14:30:00Z' }, today).toISOString()).toBe(
      '2026-06-15T14:30:00.000Z',
    );
    expect(() => demoNow({ DEMO_NOW: 'walk' }, today)).toThrow(/DEMO_NOW/);
  });
});

describe.skipIf(!available)('live: the demo seed', () => {
  let live: LiveDatabase;
  let installer: string;

  beforeAll(async () => {
    live = await createLiveDatabase('seed_demo');
    const organizationId = await seedOrganization(live.db);
    installer = await seedUser(live.db, organizationId, { role: 'admin' });
    await seedDemoData(live.db);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('gives "Alex" to the instance’s own administrator, not a demo one', async () => {
    expect(await demoAdmin(live.db)).toEqual({ id: installer });
    const [alex] = await live.db
      .select({ userId: schema.userPreference.userId })
      .from(schema.userPreference)
      .where(eq(schema.userPreference.displayName, 'Alex'));
    expect(alex?.userId).toBe(installer);
  });

  it('dates its usage inside the Usage page’s 90 days', async () => {
    const [range] = await live.db
      .select({
        oldest: sql<Date>`min(${schema.usageEvent.occurredAt})`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.usageEvent);
    expect(range?.count).toBeGreaterThan(0);
    expect(Date.now() - new Date(range!.oldest).getTime()).toBeLessThan(90 * 86_400_000);
  });

  it('records no audit entry about a policy that does not exist', async () => {
    const entries = await live.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'policy.publish'));
    expect(entries).toEqual([]);
  });
});
