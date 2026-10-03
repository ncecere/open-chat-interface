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
import { pruneUsageEvents } from '../../services/lifecycle/retention.js';
import { getUsageSummary, reserveQuotaForRun } from '../../services/quota/index.js';
import type { EvaluablePolicy } from '../../services/quota/policy.js';
import {
  RESERVATION_TTL_MS,
  releaseReservation,
  reserveQuota,
  settleReservation,
  sweepAbandonedReservations,
  type UsageReservation,
} from '../../services/quota/reservation.js';

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
const modelSlug = 'settlement-model';
const pricing = { inputPriceMicros: 1_000_000, outputPriceMicros: 2_000_000 };
const hold = { costMicros: 100, tokens: 50 };
const measured = { tokensIn: 7, tokensOut: 11 };
const measuredTotals = { messageCount: 1, ...measured, costMicros: 29 };

describe.skipIf(!available)('live Postgres: durable quota settlement', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('quota_settlement');
    // Independent service calls must contend in Postgres, not a one-slot pool.
    pool = createDatabase(live.connectionString, { max: 8 });
    db = pool.db;
    state.db = db;
    state.organizationId = await seedOrganization(db);
    const [provider] = await db
      .insert(schema.provider)
      .values({ organizationId: state.organizationId, kind: 'openai', label: 'No calls' })
      .returning();
    await db.insert(schema.model).values({
      organizationId: state.organizationId,
      providerId: provider!.id,
      slug: modelSlug,
      upstreamModelId: modelSlug,
      displayName: 'Settlement fixture',
      ...pricing,
    });
  });

  beforeEach(async () => {
    await db.delete(schema.usageEvent);
    await db.delete(schema.usageRecord);
    await db.delete(schema.thread);
    await db.delete(schema.quotaPolicy);
    await db.update(schema.model).set(pricing);
    userId = await seedUser(db, state.organizationId);
  });

  async function removeFailureInjection() {
    await db.execute(sql`drop trigger if exists reject_settlement_rollup on usage_record`);
    await db.execute(sql`drop function if exists reject_settlement_rollup_write()`);
  }

  afterEach(async () => {
    await removeFailureInjection();
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    state.db = null;
    await live?.destroy();
  });

  function reserve(overrides: Partial<Parameters<typeof reserveQuota>[0]> = {}) {
    return reserveQuota({
      userId,
      role: 'user',
      modelSlug,
      policies: [],
      pricing: { ...pricing },
      reserve: { ...hold },
      ...overrides,
    });
  }

  async function event(id: string) {
    const [row] = await db.select().from(schema.usageEvent).where(eq(schema.usageEvent.id, id));
    return row;
  }

  async function records(owner = userId) {
    return db
      .select()
      .from(schema.usageRecord)
      .where(eq(schema.usageRecord.userId, owner))
      .orderBy(schema.usageRecord.day, schema.usageRecord.modelSlug);
  }

  async function snapshot() {
    return {
      events: await db.select().from(schema.usageEvent).orderBy(schema.usageEvent.id),
      records: await db.select().from(schema.usageRecord).orderBy(schema.usageRecord.id),
    };
  }

  async function expectMeasured(reservation: UsageReservation) {
    expect(await event(reservation.id)).toMatchObject({
      ...measuredTotals,
      pending: false,
      usageUnknown: false,
      reservedTokens: 0,
      reservedCostMicros: 0,
    });
    const rows = await records(reservation.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(measuredTotals);
  }

  async function age(reservation: UsageReservation, now = new Date()) {
    const occurredAt = new Date(now.getTime() - RESERVATION_TTL_MS - 60_000);
    await db
      .update(schema.usageEvent)
      .set({ occurredAt })
      .where(eq(schema.usageEvent.id, reservation.id));
    return now;
  }

  async function insertClaim(id: string, owner = userId, role: 'assistant' | 'user' = 'assistant') {
    const [thread] = await db
      .insert(schema.thread)
      .values({ organizationId: state.organizationId, userId: owner })
      .returning();
    await db.insert(schema.message).values({
      id,
      threadId: thread!.id,
      userId: owner,
      role,
      status: 'streaming',
      modelSlug,
    });
  }

  async function rejectRollupWrites() {
    await db.execute(sql`
      create function reject_settlement_rollup_write() returns trigger language plpgsql as $$
      begin
        raise exception 'Injected quota rollup failure' using errcode = 'P0001';
      end $$
    `);
    await db.execute(sql`
      create trigger reject_settlement_rollup before insert or update or delete on usage_record
      for each row execute function reject_settlement_rollup_write()
    `);
  }

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
