import { MICROS_PER_DOLLAR } from '@oci/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getDefaultOrganizationId: vi.fn().mockResolvedValue('organization-1'),
}));

vi.mock('../../db/index.js', () => ({ db: { select: mocks.select } }));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: mocks.getDefaultOrganizationId,
}));

import { checkQuota, getUsageSummary } from '../../services/quota/index.js';

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

/** Mirrors the usage aggregate: select().from().where() */
function totalsQuery(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return chain;
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

describe('integration with mocked DB: quota policy enforcement', () => {
  beforeEach(() => {
    mocks.select.mockReset();
  });

  it('does not query usage when no policy applies to the role', async () => {
    mocks.select.mockReturnValueOnce(policyQuery([]));

    await expect(checkQuota('user-1', 'user')).resolves.toBeUndefined();
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it('allows usage strictly below the limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(totalsQuery([{ messages: 4, tokens: 0, costMicros: 0 }]));

    await expect(checkQuota('user-1', 'user')).resolves.toBeUndefined();
  });

  it('blocks when usage exactly reaches the limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy]))
      .mockReturnValueOnce(totalsQuery([{ messages: 5, tokens: 0, costMicros: 0 }]));

    await expect(checkQuota('user-1', 'user')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 429,
    });
  });

  it('blocks on a budget policy once spend reaches the dollar limit', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(
        totalsQuery([{ messages: 1, tokens: 10, costMicros: 5 * MICROS_PER_DOLLAR }]),
      );

    await expect(checkQuota('user-1', 'user')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('enforces every policy applied to the role, not just the first', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy, budgetPolicy]))
      .mockReturnValueOnce(totalsQuery([{ messages: 1, tokens: 0, costMicros: 0 }]))
      .mockReturnValueOnce(
        totalsQuery([{ messages: 1, tokens: 0, costMicros: 6 * MICROS_PER_DOLLAR }]),
      );

    await expect(checkQuota('user-1', 'user')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('normalizes bigint sums returned as strings by postgres', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([budgetPolicy]))
      .mockReturnValueOnce(totalsQuery([{ messages: '1', tokens: '10', costMicros: '5000000' }]));

    await expect(checkQuota('user-1', 'user')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('summarizes each applied policy separately', async () => {
    mocks.select
      .mockReturnValueOnce(policyQuery([messagePolicy, budgetPolicy]))
      .mockReturnValueOnce(totalsQuery([{ messages: 2, tokens: 0, costMicros: 0 }]))
      .mockReturnValueOnce(
        totalsQuery([{ messages: 2, tokens: 0, costMicros: 1 * MICROS_PER_DOLLAR }]),
      )
      .mockReturnValueOnce(totalsQuery([{ messages: 2, tokens: 40, costMicros: 1_000_000 }]));

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
