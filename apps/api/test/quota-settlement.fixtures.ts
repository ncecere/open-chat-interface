import { type Database, eq, schema, sql } from '@oci/db';
import { expect } from 'vitest';
import {
  RESERVATION_TTL_MS,
  reserveQuota,
  type UsageReservation,
} from '../src/services/quota/reservation.js';

/**
 * Shared fixtures for the live durable quota settlement suites
 * (quota-settlement-*.live.test.ts): the model, prices and amounts, and
 * helpers over reservations, usage events, rollups, active claims and an
 * injected rollup failure. Each suite declares its own `vi.mock` block and
 * `state`; the services imported here are the mocked ones.
 */
export const modelSlug = 'settlement-model';
export const pricing = { inputPriceMicros: 1_000_000, outputPriceMicros: 2_000_000 };
export const hold = { costMicros: 100, tokens: 50 };
export const measured = { tokensIn: 7, tokensOut: 11 };
export const measuredTotals = { messageCount: 1, ...measured, costMicros: 29 };

export interface QuotaContext {
  db: Database;
  /** The person seeded for the current test. */
  userId: string;
}

/** Inserts the provider and the priced model every reservation refers to. */
export async function seedSettlementModel(db: Database, organizationId: string) {
  const [provider] = await db
    .insert(schema.provider)
    .values({ organizationId, kind: 'openai', label: 'No calls' })
    .returning();
  await db.insert(schema.model).values({
    organizationId,
    providerId: provider!.id,
    slug: modelSlug,
    upstreamModelId: modelSlug,
    displayName: 'Settlement fixture',
    ...pricing,
  });
}

/** Helpers over the live database; `context` is read when each is called. */
export function quotaHelpers(state: { organizationId: string }, context: () => QuotaContext) {
  async function removeFailureInjection() {
    const { db } = context();
    await db.execute(sql`drop trigger if exists reject_settlement_rollup on usage_record`);
    await db.execute(sql`drop function if exists reject_settlement_rollup_write()`);
  }

  function reserve(overrides: Partial<Parameters<typeof reserveQuota>[0]> = {}) {
    return reserveQuota({
      userId: context().userId,
      role: 'user',
      modelSlug,
      policies: [],
      pricing: { ...pricing },
      reserve: { ...hold },
      ...overrides,
    });
  }

  async function event(id: string) {
    const [row] = await context()
      .db.select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.id, id));
    return row;
  }

  async function records(owner = context().userId) {
    return context()
      .db.select()
      .from(schema.usageRecord)
      .where(eq(schema.usageRecord.userId, owner))
      .orderBy(schema.usageRecord.day, schema.usageRecord.modelSlug);
  }

  async function snapshot() {
    const { db } = context();
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
    await context()
      .db.update(schema.usageEvent)
      .set({ occurredAt })
      .where(eq(schema.usageEvent.id, reservation.id));
    return now;
  }

  async function insertClaim(
    id: string,
    owner = context().userId,
    role: 'assistant' | 'user' = 'assistant',
  ) {
    const { db } = context();
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
    const { db } = context();
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

  return {
    removeFailureInjection,
    reserve,
    event,
    records,
    snapshot,
    expectMeasured,
    age,
    insertClaim,
    rejectRollupWrites,
  };
}
