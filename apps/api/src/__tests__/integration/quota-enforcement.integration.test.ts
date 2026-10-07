import { schema } from '@oci/db';
import { MICROS_PER_DOLLAR } from '@oci/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn().mockResolvedValue(undefined),
  getDefaultOrganizationId: vi.fn().mockResolvedValue('organization-1'),
  getReserveAmounts: vi.fn().mockResolvedValue({ costMicros: 250_000, tokens: 4_000 }),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    transaction: mocks.transaction,
    execute: mocks.execute,
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: mocks.getDefaultOrganizationId,
}));
vi.mock('../../services/lifecycle/settings.js', () => ({
  getReserveAmounts: mocks.getReserveAmounts,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getUsageSummary, reserveQuotaForRun } from '../../services/quota/index.js';

/** Mirrors the policy lookup: select().from().innerJoin().where().orderBy() */
function policyQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return chain;
}

/** Mirrors both the usage aggregate and the model-pricing lookup. */
function tableQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
  };
  return chain;
}

/**
 * The model-scope lookup that follows every policy query. Returning no rows
 * leaves each policy unscoped, which is how a policy applies to every model.
 */
function scopeQuery(rows: unknown[] = []) {
  return tableQuery(rows);
}

/**
 * The per-user override lookup that follows the scope query. No rows means the
 * user is on their role's limit.
 */
function overrideQuery(rows: unknown[] = []) {
  return tableQuery(rows);
}

const messagePolicy = {
  id: 'policy-messages',
  name: 'Daily messages',
  metric: 'messages',
  limitValue: 5,
  windowKind: 'daily',
  windowHours: null,
  timezone: 'UTC',
};

const budgetPolicy = {
  id: 'policy-budget',
  name: 'Monthly budget',
  metric: 'cost',
  limitValue: 5 * MICROS_PER_DOLLAR,
  windowKind: 'monthly',
  windowHours: null,
  timezone: 'UTC',
};

const unpriced = { inputPriceMicros: null, outputPriceMicros: null };

/** Runs the reservation transaction against the mocked query chain. */
/** Captures the row a reservation writes, so its held amounts can be asserted. */
let reservedRow: Record<string, unknown> | null = null;

function runTransaction() {
  reservedRow = null;
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: mocks.execute,
      select: (...args: unknown[]) => ({
        from: (table: unknown) =>
          table === schema.user
            ? { where: () => ({ for: async () => [{ id: 'user-1' }] }) }
            : mocks.select(...args).from(table),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          reservedRow = row;
          const returning = () => Promise.resolve([{ id: row.id ?? 'reservation-1' }]);
          // The run's ID is inserted once (#326): a repeat finds its own row.
          return { returning, onConflictDoNothing: () => ({ returning }) };
        },
      }),
    }),
  );
}

describe('integration with mocked DB: quota reservation', () => {
  beforeEach(() => {
    mocks.select.mockReset();
    mocks.transaction.mockReset();
    // Reset clears the resolved value, and the reservation path reads this
    // before opening its transaction.
    mocks.getReserveAmounts.mockResolvedValue({ costMicros: 250_000, tokens: 4_000 });
    runTransaction();
  });

  it('gives unlimited runs a durable identity without reserving estimated spend', async () => {
    mocks.select.mockReturnValueOnce(policyQuery([])).mockReturnValueOnce(tableQuery([unpriced]));
    await expect(
      reserveQuotaForRun({
        userId: 'user-1',
        role: 'user',
        modelSlug: 'm',
        runId: 'run-unlimited',
      }),
    ).resolves.toMatchObject({ id: 'run-unlimited' });
    expect(reservedRow).toMatchObject({
      id: 'run-unlimited',
      pending: true,
      usageUnknown: true,
      messageCount: 1,
      reservedCostMicros: 0,
      reservedTokens: 0,
    });
    expect(mocks.getReserveAmounts).not.toHaveBeenCalled();
  });

  it('reserves when usage is strictly below the limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 4, tokens: 0, costMicros: 0 }]));

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).resolves.toMatchObject({ id: 'reservation-1' });
  });

  it('enforces a per-user override instead of the role limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      // Raised from the role's 5 to 20 for this person.
      .mockReturnValueOnce(overrideQuery([{ policyId: 'policy-messages', limitValue: 20 }]))
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 9, tokens: 0, costMicros: 0 }]));

    // Nine messages would exceed the role limit but sits well inside the
    // override, so the run must be allowed.
    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).resolves.toMatchObject({ id: 'reservation-1' });
  });

  it('still refuses once an overridden limit is itself reached', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery([{ policyId: 'policy-messages', limitValue: 20 }]))
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 20, tokens: 0, costMicros: 0 }]));

    // An override raises a limit; it does not remove one.
    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('holds the configured reserve rather than a hard-coded amount', async () => {
    mocks.getReserveAmounts.mockResolvedValue({ costMicros: 900_000, tokens: 12_000 });
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 0, tokens: 0, costMicros: 0 }]));

    await reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' });

    expect(reservedRow).toMatchObject({ reservedCostMicros: 900_000, reservedTokens: 12_000 });
  });

  it('never reserves more than the allowance still has left', async () => {
    // Otherwise the tail of a budget becomes unspendable: someone with less
    // remaining than the reserve could never start another run.
    mocks.getReserveAmounts.mockResolvedValue({ costMicros: 250_000, tokens: 4_000 });
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(
        // $4.90 of a $5.00 budget already spent, so only $0.10 remains.
        tableQuery([{ messages: 0, tokens: 0, costMicros: 4.9 * MICROS_PER_DOLLAR }]),
      );

    await reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' });

    expect(reservedRow).toMatchObject({ reservedCostMicros: 0.1 * MICROS_PER_DOLLAR });
  });

  it('refuses when usage exactly reaches the limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 5, tokens: 0, costMicros: 0 }]));

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
  });

  it('counts an in-flight reservation, so a concurrent run cannot overshoot', async () => {
    // The second request sees the first request's pending row in the total.
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 5, tokens: 0, costMicros: 0 }]));

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('serializes reservations per user with an advisory lock', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 0, tokens: 0, costMicros: 0 }]));

    await reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' });

    expect(mocks.execute).toHaveBeenCalled();
  });

  it('refuses on a budget policy once spend reaches the dollar limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(
        tableQuery([{ messages: 1, tokens: 10, costMicros: 5 * MICROS_PER_DOLLAR }]),
      );

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('enforces every policy applied to the role, not just the first', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy, budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: 1, tokens: 0, costMicros: 0 }]))
      .mockReturnValueOnce(
        tableQuery([{ messages: 1, tokens: 0, costMicros: 6 * MICROS_PER_DOLLAR }]),
      );

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('normalizes bigint sums returned as strings by postgres', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([unpriced]))
      .mockReturnValueOnce(tableQuery([{ messages: '1', tokens: '10', costMicros: '5000000' }]));

    await expect(
      reserveQuotaForRun({ userId: 'user-1', role: 'user', modelSlug: 'm' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

describe('integration with mocked DB: usage summary', () => {
  beforeEach(() => {
    mocks.select.mockReset();
  });

  it('summarizes each applied policy separately', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy, budgetPolicy]))
      .mockReturnValueOnce(scopeQuery())
      .mockReturnValueOnce(overrideQuery())
      .mockReturnValueOnce(tableQuery([{ messages: 2, tokens: 0, costMicros: 0 }]))
      .mockReturnValueOnce(
        tableQuery([{ messages: 2, tokens: 0, costMicros: 1 * MICROS_PER_DOLLAR }]),
      )
      .mockReturnValueOnce(tableQuery([{ messages: 2, tokens: 40, costMicros: 1_000_000 }]));

    const summary = await getUsageSummary('user-1', 'user');

    expect(summary.allowances).toHaveLength(2);
    expect(summary.allowances[0]).toMatchObject({ name: 'Daily messages', used: 2, remaining: 3 });
    expect(summary.allowances[1]).toMatchObject({
      name: 'Monthly budget',
      used: 1 * MICROS_PER_DOLLAR,
      remaining: 4 * MICROS_PER_DOLLAR,
    });
    expect(summary.recent).toEqual({ messages: 2, tokens: 40, costMicros: 1_000_000 });
  });
});
