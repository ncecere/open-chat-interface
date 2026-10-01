import type { Database } from '@oci/db';
import { schema } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { dailyUsage, modelUsage, topConsumers, usageTotals } from '../../services/usage-report.js';

const state = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getDisplayTimezone: async () => 'UTC',
}));

const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: usage report arithmetic', () => {
  let live: LiveDatabase;
  let userId: string;
  let organizationId: string;
  const modelSlug = 'report-fixture';

  beforeAll(async () => {
    live = await createLiveDatabase('usage_report');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, organizationId);
    const [provider] = await live.db
      .insert(schema.provider)
      .values({
        organizationId,
        kind: 'openai',
        label: 'No requests',
      })
      .returning();
    await live.db.insert(schema.model).values({
      organizationId,
      providerId: provider!.id,
      slug: modelSlug,
      upstreamModelId: modelSlug,
      displayName: 'Reporting fixture',
    });
  });
  beforeEach(async () => {
    await live.db.delete(schema.usageEvent);
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('reports an empty ledger without invented activity', async () => {
    expect(await usageTotals(30)).toEqual({
      messages: 0,
      tokens: 0,
      costMicros: 0,
      activeUsers: 0,
    });
    expect(await dailyUsage(30)).toEqual([]);
    expect(await modelUsage(30)).toEqual({ entries: [], totalCount: 0 });
    expect(await topConsumers(30)).toEqual({ entries: [], totalCount: 0 });
  });

  async function largeEvents() {
    // Both operands fit int32; their addition does not. Two rows also exercise SUM.
    await live.db.insert(schema.usageEvent).values(
      [0, 1].map(() => ({
        organizationId,
        userId,
        modelSlug,
        tokensIn: 1_500_000_000,
        tokensOut: 1_500_000_000,
        costMicros: 10,
        messageCount: 1,
        pending: false,
      })),
    );
  }
  it('widens operands before addition in overall totals', async () => {
    await largeEvents();
    expect(await usageTotals(30)).toEqual({
      messages: 2,
      tokens: 6_000_000_000,
      costMicros: 20,
      activeUsers: 1,
    });
  });
  it('widens operands before addition in daily totals', async () => {
    await largeEvents();
    expect(await dailyUsage(30)).toEqual([
      expect.objectContaining({ messages: 2, tokens: 6_000_000_000, costMicros: 20 }),
    ]);
  });
  it('widens operands before addition in model totals', async () => {
    await largeEvents();
    expect(await modelUsage(30)).toEqual({
      totalCount: 1,
      entries: [
        expect.objectContaining({
          modelSlug,
          messages: 2,
          tokens: 6_000_000_000,
          costMicros: 20,
          errors: 0,
        }),
      ],
    });
  });
  it('widens operands before addition in consumer totals', async () => {
    await largeEvents();
    expect(await topConsumers(30)).toEqual({
      totalCount: 1,
      entries: [
        expect.objectContaining({ userId, messages: 2, tokens: 6_000_000_000, costMicros: 20 }),
      ],
    });
  });
});
