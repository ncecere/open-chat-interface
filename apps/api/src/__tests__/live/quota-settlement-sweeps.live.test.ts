import { randomUUID } from 'node:crypto';
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
import { pruneUsageEvents } from '../../services/lifecycle/retention.js';
import { getUsageSummary } from '../../services/quota/index.js';
import type { EvaluablePolicy } from '../../services/quota/policy.js';
import {
  RESERVATION_TTL_MS,
  settleReservation,
  sweepAbandonedReservations,
} from '../../services/quota/reservation.js';

/**
 * Durable quota settlement against the real migrated schema. This suite covers
 * sweeping abandoned reservations: batches, swept events amended later,
 * retention, rollback, concurrent replicas, locks and active claims;
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
    age,
    event,
    expectMeasured,
    insertClaim,
    records,
    rejectRollupWrites,
    reserve,
    snapshot,
  } = quotaHelpers(state, () => ({ db, userId }));

  beforeAll(async () => {
    live = await createLiveDatabase('quota_settlement_sweeps');
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

  it('bounds each sweep to 200 eligible events and leaves the remainder for a later pass', async () => {
    const now = new Date('2025-02-04T12:00:00Z');
    const occurredAt = new Date(now.getTime() - RESERVATION_TTL_MS - 60_000);
    await db.insert(schema.usageEvent).values(
      Array.from({ length: 201 }, () => ({
        organizationId: state.organizationId,
        userId,
        modelSlug,
        occurredAt,
        pending: true,
        ...pricing,
        reservedCostMicros: hold.costMicros,
        reservedTokens: hold.tokens,
      })),
    );
    expect(await sweepAbandonedReservations(now)).toBe(200);
    const firstPass = (await snapshot()).events;
    expect(firstPass.filter((row) => row.pending)).toHaveLength(1);
    expect(firstPass.filter((row) => !row.pending && row.usageUnknown)).toHaveLength(200);
    expect((await records())[0]).toMatchObject({ messageCount: 200, costMicros: 0 });
    expect(await sweepAbandonedReservations(now)).toBe(1);
    expect((await records())[0]).toMatchObject({ messageCount: 201, costMicros: 0 });
  }, 30_000);

  it('amends a swept unknown event using its original day without another message', async () => {
    const reservation = await reserve();
    const now = new Date('2025-02-04T00:05:00Z');
    await age(reservation, now);
    expect(await sweepAbandonedReservations(now)).toBe(1);
    expect(await event(reservation.id)).toMatchObject({
      pending: false,
      usageUnknown: true,
      reservedTokens: hold.tokens,
      reservedCostMicros: hold.costMicros,
    });
    expect((await records())[0]).toMatchObject({ day: '2025-02-03', messageCount: 1 });
    await settleReservation(reservation, measured);
    await expectMeasured(reservation);
    expect((await records())[0]?.day).toBe('2025-02-03');
  });

  it('retains partial actuals arriving after a sweep and merges them without duplicate charges', async () => {
    const reservation = await reserve();
    const now = await age(reservation);
    expect(await sweepAbandonedReservations(now)).toBe(1);
    await settleReservation(reservation, { tokensIn: 5000 });
    expect(await event(reservation.id)).toMatchObject({
      tokensIn: 5000,
      tokensOut: 0,
      costMicros: 5000,
      usageUnknown: true,
      reservedTokens: 0,
      reservedCostMicros: 0,
    });
    expect((await records())[0]).toMatchObject({
      messageCount: 1,
      tokensIn: 5000,
      costMicros: 5000,
    });
    const partial = await snapshot();
    await Promise.all([
      settleReservation(reservation, { tokensIn: 5000 }),
      settleReservation(reservation, null),
      settleReservation(reservation, { tokensIn: 20 }),
    ]);
    expect(await snapshot()).toEqual(partial);
    await settleReservation(reservation, { tokensOut: 11 });
    expect((await records())[0]).toMatchObject({
      messageCount: 1,
      tokensIn: 5000,
      tokensOut: 11,
      costMicros: 5022,
    });
    await settleReservation(reservation, measured);
    await expectMeasured(reservation);
  });

  it('protects unresolved events from retention until a complete report reconciles them', async () => {
    const unresolved = await reserve();
    const completed = await reserve();
    const now = new Date();
    await db
      .update(schema.usageEvent)
      .set({ occurredAt: new Date(now.getTime() - 45 * 24 * 3600_000) });
    await settleReservation(unresolved, null);
    await settleReservation(completed, measured);
    expect(await pruneUsageEvents(now)).toBe(1);
    expect(await event(unresolved.id)).toMatchObject({ usageUnknown: true });
    expect(await event(completed.id)).toBeUndefined();
    await settleReservation(unresolved, measured);
    expect((await records())[0]).toMatchObject({
      messageCount: 2,
      tokensIn: 14,
      tokensOut: 22,
      costMicros: 58,
    });
    expect(await pruneUsageEvents(now)).toBe(1);
    expect(await event(unresolved.id)).toBeUndefined();
    expect((await records())[0]).toMatchObject({ messageCount: 2, costMicros: 58 });
  });

  it('rolls back one swept event on rollup failure and counts its message on retry', async () => {
    const reservation = await reserve();
    const now = await age(reservation);
    const before = await snapshot();
    await rejectRollupWrites();
    await expect(sweepAbandonedReservations(now)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await removeFailureInjection();
    expect(await sweepAbandonedReservations(now)).toBe(1);
    expect(await sweepAbandonedReservations(now)).toBe(0);
    expect(await event(reservation.id)).toMatchObject({ pending: false, usageUnknown: true });
    expect((await records())[0]).toMatchObject({ messageCount: 1, costMicros: 0 });
  });

  it('does not double-count when replicas sweep the same abandoned events concurrently', async () => {
    const reservations = await Promise.all(Array.from({ length: 6 }, () => reserve()));
    const now = new Date();
    await Promise.all(reservations.map((reservation) => age(reservation, now)));
    const counts = await Promise.all(
      Array.from({ length: 4 }, () => sweepAbandonedReservations(now)),
    );
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(6);
    expect(await sweepAbandonedReservations(now)).toBe(0);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageCount: 6, tokensIn: 0, tokensOut: 0, costMicros: 0 });
    expect((await snapshot()).events.every((row) => !row.pending && row.usageUnknown)).toBe(true);
  });

  it('skips an event locked by another transaction and recovers it on a later sweep', async () => {
    const reservation = await reserve();
    const now = await age(reservation);
    const owner = await pool.sql.reserve();
    await owner`begin`;
    await owner`select id from usage_event where id = ${reservation.id} for update`;
    try {
      expect(await sweepAbandonedReservations(now)).toBe(0);
    } finally {
      await owner`rollback`;
      owner.release();
    }
    expect(await sweepAbandonedReservations(now)).toBe(1);
    expect((await records())[0]).toMatchObject({ messageCount: 1 });
  });

  it('excludes an active assistant older than TTL from sweeping and still counts its quota', async () => {
    const runId = randomUUID();
    const reservation = await reserve({ runId });
    expect(reservation.id).toBe(runId);
    await insertClaim(runId);
    const now = await age(reservation);
    const [storedPolicy] = await db
      .insert(schema.quotaPolicy)
      .values({
        organizationId: state.organizationId,
        name: 'One active message',
        metric: 'messages',
        limitValue: 1,
        windowKind: 'rolling',
        windowHours: 24,
        timezone: 'UTC',
      })
      .returning();
    await db.insert(schema.quotaPolicyRole).values({ policyId: storedPolicy!.id, role: 'user' });
    const policy: EvaluablePolicy = { ...storedPolicy!, modelSlugs: [] };

    expect(await sweepAbandonedReservations(now)).toBe(0);
    expect(await event(runId)).toMatchObject({ pending: true, reservedTokens: hold.tokens });
    const summary = await getUsageSummary(userId, 'user');
    expect(summary.allowances).toEqual([expect.objectContaining({ used: 1, exceeded: true })]);
    expect(summary.recent).toEqual({
      messages: 1,
      tokens: hold.tokens,
      costMicros: hold.costMicros,
    });
    const before = await snapshot();
    await expect(reserve({ policies: [policy] })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);

    await db.update(schema.message).set({ status: 'complete' }).where(eq(schema.message.id, runId));
    expect(await sweepAbandonedReservations(now)).toBe(1);
  });

  it('does not mistake another user or a non-assistant streaming message for an active claim', async () => {
    const stranger = await seedUser(db, state.organizationId);
    const wrongOwner = await reserve({ runId: randomUUID() });
    const wrongRole = await reserve({ runId: randomUUID() });
    await insertClaim(wrongOwner.id, stranger);
    await insertClaim(wrongRole.id, userId, 'user');
    const now = new Date();
    await age(wrongOwner, now);
    await age(wrongRole, now);
    expect(await sweepAbandonedReservations(now)).toBe(2);
    expect((await records())[0]).toMatchObject({ messageCount: 2 });
  });

  it('retains uncertain spend estimates through expiry and sweeping until actual usage arrives', async () => {
    const policy: EvaluablePolicy = {
      id: randomUUID(),
      name: 'Small budget',
      metric: 'cost',
      limitValue: 100,
      windowKind: 'rolling',
      windowHours: 24,
      timezone: 'UTC',
      modelSlugs: [],
    };
    const reservation = await reserve({ policies: [policy] });
    const now = await age(reservation);
    await expect(reserve({ policies: [policy] })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((await getUsageSummary(userId, 'user')).recent.costMicros).toBe(100);
    expect(await sweepAbandonedReservations(now)).toBe(1);
    expect((await records())[0]).toMatchObject({ messageCount: 1, costMicros: 0 });
    expect(await event(reservation.id)).toMatchObject({
      usageUnknown: true,
      reservedCostMicros: 100,
    });
    await expect(reserve({ policies: [policy] })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await settleReservation(reservation, measured);
    const next = await reserve({ policies: [policy] });
    expect(await event(next.id)).toMatchObject({ reservedCostMicros: 71 });
  });
});
