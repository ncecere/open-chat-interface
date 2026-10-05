import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, eq, schema, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  measured,
  measuredTotals,
  modelSlug,
  pricing,
  quotaHelpers,
  seedSettlementModel,
} from '../../../test/quota-settlement.fixtures.js';
import { reserveQuotaForRun } from '../../services/quota/index.js';
import { releaseReservation, settleReservation } from '../../services/quota/reservation.js';

/**
 * Durable quota settlement against the real migrated schema. This suite covers
 * releasing and reversing holds, guards on the reservation handle and the
 * counts, account deletion races and unlimited runs;
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
    live = await createLiveDatabase('quota_settlement_release');
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

  it('reverses unknown usage exactly once while preserving other usage in the same rollup', async () => {
    const kept = await reserve();
    const released = await reserve();
    await db.update(schema.usageEvent).set({ occurredAt: new Date('2025-02-03T12:00:00Z') });
    await settleReservation(kept, measured);
    await settleReservation(released, { tokensIn: 20, tokensOut: null });
    expect(await event(released.id)).toMatchObject({ usageUnknown: true });
    const beforeRelease = await snapshot();
    await rejectRollupWrites();
    await expect(releaseReservation(released)).rejects.toThrow();
    expect(await snapshot()).toEqual(beforeRelease);
    await removeFailureInjection();
    await Promise.all(Array.from({ length: 6 }, () => releaseReservation(released)));
    expect(await event(released.id)).toBeUndefined();
    await expectMeasured(kept);
    // A late report cannot resurrect an explicitly released event.
    await settleReservation(released, measured);
    await expectMeasured(kept);
  });

  it('never releases measured settled usage, including a measured zero-token report', async () => {
    const reservation = await reserve();
    await settleReservation(reservation, { tokensIn: 0, tokensOut: 0 });
    expect(await event(reservation.id)).toMatchObject({ usageUnknown: false, pending: false });
    const before = await snapshot();
    await Promise.all(Array.from({ length: 4 }, () => releaseReservation(reservation)));
    expect(await snapshot()).toEqual(before);
    expect((await records())[0]).toMatchObject({ messageCount: 1, tokensIn: 0, tokensOut: 0 });
  });

  it('releases a pending hold idempotently without creating any rollup', async () => {
    const reservation = await reserve();
    await Promise.all(Array.from({ length: 4 }, () => releaseReservation(reservation)));
    expect(await event(reservation.id)).toBeUndefined();
    expect(await records()).toEqual([]);
  });

  it('cannot alter another event with a wrong user or model in the reservation handle', async () => {
    const reservation = await reserve();
    const stranger = await seedUser(db, state.organizationId);
    const handles = [
      { ...reservation, userId: stranger },
      { ...reservation, modelSlug: 'not-the-stored-model' },
    ];
    const pending = await snapshot();
    // Either rejection or a no-op is acceptable; cross-owner mutation is not.
    for (const handle of handles) {
      await Promise.allSettled([settleReservation(handle, measured), releaseReservation(handle)]);
      expect(await snapshot()).toEqual(pending);
    }
    await settleReservation(reservation, null);
    const unknown = await snapshot();
    for (const handle of handles) {
      await Promise.allSettled([settleReservation(handle, measured), releaseReservation(handle)]);
      expect(await snapshot()).toEqual(unknown);
    }
  });

  it('rejects negative, nonfinite, and noninteger counts without changing pending or unknown usage', async () => {
    const reservation = await reserve();
    for (const phase of ['pending', 'unknown'] as const) {
      if (phase === 'unknown') await settleReservation(reservation, null);
      const before = await snapshot();
      const invalidCounts = [
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        1.5,
      ];
      for (const invalid of invalidCounts) {
        await expect(
          settleReservation(reservation, { tokensIn: invalid, tokensOut: 1 }),
        ).rejects.toThrow(RangeError);
        expect(await snapshot()).toEqual(before);
        await expect(
          settleReservation(reservation, { tokensIn: 1, tokensOut: invalid }),
        ).rejects.toThrow(RangeError);
        expect(await snapshot()).toEqual(before);
      }
    }
  });

  it('leaves consistent accounting when account deletion races settlement', async () => {
    const { deleteUser } = await import('../../services/admin-users/mutations.js');
    const admin = await seedUser(db, state.organizationId, { role: 'admin' });
    const reservation = await reserve();
    // Both legal orderings converge: settlement commits first and the measured
    // usage is kept without the person, or the deletion removes the in-flight
    // reservation before settlement can claim it.
    const results = await Promise.allSettled([
      settleReservation(reservation, measured),
      deleteUser({ id: admin, email: 'admin@example.test' }, userId),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await db.select().from(schema.user).where(eq(schema.user.id, userId))).toEqual([]);
    const kept = await event(reservation.id);
    const orphanRollups = await db
      .select()
      .from(schema.usageRecord)
      .where(sql`${schema.usageRecord.userId} is null`);
    if (kept) {
      expect(kept).toMatchObject({ ...measuredTotals, userId: null, pending: false });
      expect(orphanRollups).toEqual([expect.objectContaining({ userId: null, ...measuredTotals })]);
    } else {
      expect(orphanRollups).toEqual([]);
    }
    const before = await snapshot();
    await settleReservation(reservation, measured);
    await releaseReservation(reservation);
    expect(await snapshot()).toEqual(before);
  });

  it('reserves an unlimited run durably with zero holds and pre-generation catalog prices', async () => {
    const runId = randomUUID();
    const reservation = await reserveQuotaForRun({ userId, role: 'user', modelSlug, runId });
    expect(reservation).not.toBeNull();
    expect(reservation!.id).toBe(runId);
    expect(await event(runId)).toMatchObject({
      ...pricing,
      pending: true,
      usageUnknown: true,
      reservedTokens: 0,
      reservedCostMicros: 0,
    });
    // No assistant row is needed: run association deliberately has no extra FK.
    await db.update(schema.model).set({ inputPriceMicros: 0, outputPriceMicros: 0 });
    await settleReservation(reservation!, measured);
    await expectMeasured(reservation!);
  });
});
