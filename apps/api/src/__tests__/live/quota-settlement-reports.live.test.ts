import { createDatabase, type Database, eq, schema } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  hold,
  measured,
  modelSlug,
  pricing,
  quotaHelpers,
  seedSettlementModel,
} from '../../../test/quota-settlement.fixtures.js';
import { getUsageSummary } from '../../services/quota/index.js';
import { settleReservation } from '../../services/quota/reservation.js';

/**
 * Durable quota settlement against the real migrated schema. This suite covers
 * settling and amending usage reports: duplicates, rollups, price snapshots,
 * partial and incomplete reports, overflow and lost replies;
 * the shared fixtures live in test/quota-settlement.fixtures.ts.
 */
// Redirect the connection/organization and fix retention settings. Every accounting
// write, lock, rollback, retention delete and rollup uses the real migrated schema.
const state = vi.hoisted(() => ({ db: null as Database | null, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

vi.mock('../../services/lifecycle/settings.js', () => ({
  getRetentionSettings: async () => ({ usageEventRetentionDays: 30 }),
  getReserveAmounts: async () => ({ costMicros: 100, tokens: 50 }),
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('live Postgres: durable quota settlement', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let db: Database;
  let userId: string;

  const {
    removeFailureInjection,
    event,
    expectMeasured,
    records,
    rejectRollupWrites,
    reserve,
    snapshot,
  } = quotaHelpers(state, () => ({ db, userId }));

  beforeAll(async () => {
    live = await createLiveDatabase('quota_settlement_reports');
    // Independent service calls must contend in Postgres, not a one-slot pool.
    pool = createDatabase(live.connectionString, { max: 8 });
    db = pool.db;
    state.db = db;
    state.organizationId = await seedOrganization(db);
    await seedSettlementModel(db, state.organizationId);
  });

  beforeEach(async () => {
    await db.delete(schema.usageEvent);
    await db.delete(schema.usageRecord);
    await db.delete(schema.thread);
    await db.delete(schema.quotaPolicy);
    await db.update(schema.model).set(pricing);
    userId = await seedUser(db, state.organizationId);
  });

  afterEach(async () => {
    await removeFailureInjection();
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    state.db = null;
    await live?.destroy();
  });

  it('settles concurrent duplicate reports exactly once', async () => {
    const reservation = await reserve();
    expect(await event(reservation.id)).toMatchObject({ pending: true, usageUnknown: true });
    await Promise.all(Array.from({ length: 8 }, () => settleReservation(reservation, measured)));
    await expectMeasured(reservation);
  });

  it('adds concurrent distinct events into one same-day rollup without lost updates', async () => {
    const reservations = await Promise.all(Array.from({ length: 6 }, () => reserve()));
    const occurredAt = new Date('2025-02-03T12:00:00Z');
    await db.update(schema.usageEvent).set({ occurredAt });
    await Promise.all(
      reservations.map((reservation, i) =>
        settleReservation(reservation, { tokensIn: i + 1, tokensOut: 2 * (i + 1) }),
      ),
    );
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: '2025-02-03',
      messageCount: 6,
      tokensIn: 21,
      tokensOut: 42,
      costMicros: 105,
    });
    const events = (await snapshot()).events;
    expect(events).toHaveLength(6);
    expect(events.every((row) => !row.pending && !row.usageUnknown)).toBe(true);
  });

  it('uses the stored UTC day and price snapshot, not current catalog or mutable handle prices', async () => {
    const reservation = await reserve();
    // Local March 1 is still February 28 in UTC, and settlement happens much later.
    const occurredAt = new Date('2025-03-01T00:15:00+02:00');
    await db
      .update(schema.usageEvent)
      .set({ occurredAt })
      .where(eq(schema.usageEvent.id, reservation.id));
    reservation.pricing.inputPriceMicros = 900_000_000;
    reservation.pricing.outputPriceMicros = 900_000_000;
    await db.update(schema.model).set({ inputPriceMicros: 0, outputPriceMicros: 0 });

    await settleReservation(reservation, measured);
    await expectMeasured(reservation);
    expect(await event(reservation.id)).toMatchObject({ ...pricing, occurredAt });
    expect((await records())[0]).toMatchObject({
      organizationId: state.organizationId,
      userId,
      modelSlug,
      day: '2025-02-28',
    });
  });

  it('rolls back pending settlement and unknown amendment on rollup failure, then retries', async () => {
    for (const phase of ['pending', 'unknown'] as const) {
      const owner = await seedUser(db, state.organizationId);
      const reservation = await reserve({ userId: owner });
      if (phase === 'unknown') await settleReservation(reservation, null);
      const before = await snapshot();
      await rejectRollupWrites();
      await expect(settleReservation(reservation, measured)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await removeFailureInjection();
      await settleReservation(reservation, measured);
      await expectMeasured(reservation);
    }
  });

  it('amends a null report with measured usage without counting a second message', async () => {
    const reservation = await reserve();
    await settleReservation(reservation, null);
    expect(await event(reservation.id)).toMatchObject({
      pending: false,
      usageUnknown: true,
      reservedTokens: hold.tokens,
      reservedCostMicros: hold.costMicros,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
    });
    expect((await records())[0]).toMatchObject({ messageCount: 1, costMicros: 0 });
    await settleReservation(reservation, measured);
    await expectMeasured(reservation);
  });

  it('keeps incomplete reports amendable, including omitted and null token fields', async () => {
    const reports = [{ tokensIn: 20 }, { tokensOut: 30 }, { tokensIn: null, tokensOut: 30 }, {}];
    for (const usage of reports) {
      const owner = await seedUser(db, state.organizationId);
      const reservation = await reserve({ userId: owner });
      await settleReservation(reservation, usage);
      expect(await event(reservation.id)).toMatchObject({ pending: false, usageUnknown: true });
      expect((await records(owner))[0]).toMatchObject({ messageCount: 1 });
      // Lower final values also catch amendments that add totals instead of deltas.
      await settleReservation(reservation, measured);
      await expectMeasured(reservation);
    }
  });

  it('merges partial reports idempotently and ignores reports after complete settlement', async () => {
    const reservation = await reserve();
    await settleReservation(reservation, null);
    await Promise.all([
      settleReservation(reservation, null),
      settleReservation(reservation, {}),
      settleReservation(reservation, { tokensIn: 100 }),
      settleReservation(reservation, { tokensIn: null, tokensOut: 200 }),
    ]);
    expect(await event(reservation.id)).toMatchObject({
      tokensIn: 100,
      tokensOut: 200,
      costMicros: 500,
      usageUnknown: true,
    });
    expect((await records())[0]).toMatchObject({ messageCount: 1, costMicros: 500 });
    const unknown = await snapshot();
    await Promise.all([
      settleReservation(reservation, null),
      settleReservation(reservation, {}),
      settleReservation(reservation, { tokensIn: 100 }),
      settleReservation(reservation, { tokensOut: 200 }),
      settleReservation(reservation, { tokensIn: 10 }),
    ]);
    expect(await snapshot()).toEqual(unknown);
    await settleReservation(reservation, measured);
    const known = await snapshot();
    await Promise.all([
      settleReservation(reservation, null),
      settleReservation(reservation, {}),
      settleReservation(reservation, measured),
      settleReservation(reservation, { tokensIn: 999, tokensOut: 999 }),
    ]);
    expect(await snapshot()).toEqual(known);
  });

  it('sums large valid reports without int32 overflow in rollups or quota reads', async () => {
    const reservations = [await reserve(), await reserve()];
    await Promise.all(
      reservations.map((reservation) =>
        settleReservation(reservation, {
          tokensIn: 1_500_000_000,
          tokensOut: 1_500_000_000,
        }),
      ),
    );
    const totals = (await records()).reduce(
      (sum, row) => ({
        tokensIn: sum.tokensIn + row.tokensIn,
        tokensOut: sum.tokensOut + row.tokensOut,
      }),
      { tokensIn: 0, tokensOut: 0 },
    );
    expect(totals).toEqual({ tokensIn: 3_000_000_000, tokensOut: 3_000_000_000 });
    expect((await getUsageSummary(userId, 'user')).recent.tokens).toBe(6_000_000_000);
  });

  it('does not silently recreate a missing ledger when amending unknown usage', async () => {
    const reservation = await reserve();
    await settleReservation(reservation, null);
    await db.delete(schema.usageRecord);
    const before = await snapshot();
    await expect(settleReservation(reservation, measured)).rejects.toThrow(
      'Usage rollup is missing or inconsistent',
    );
    expect(await snapshot()).toEqual(before);
  });

  it('retries safely after a simulated lost successful settlement reply', async () => {
    const reservation = await reserve();
    let loseReply = true;
    state.db = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction')
          return async (callback: Parameters<Database['transaction']>[0]) => {
            const result = await target.transaction(callback);
            if (loseReply) {
              loseReply = false;
              throw new Error('Injected lost settlement reply');
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await expect(settleReservation(reservation, measured)).rejects.toThrow(
        'Injected lost settlement reply',
      );
      const committed = await snapshot();
      await settleReservation(reservation, measured);
      expect(await snapshot()).toEqual(committed);
      await expectMeasured(reservation);
    } finally {
      state.db = db;
    }
  });
});
