import { MICROS_PER_DOLLAR, upsertQuotaPolicySchema } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAllowance,
  calculateCostMicros,
  type EvaluablePolicy,
  formatMicros,
  limitMessage,
  usedForMetric,
} from '../../services/quota/policy.js';

const policy = (overrides: Partial<EvaluablePolicy> = {}): EvaluablePolicy => ({
  id: 'policy-1',
  name: 'Daily messages',
  metric: 'messages',
  limitValue: 100,
  windowKind: 'daily',
  windowHours: null,
  timezone: 'UTC',
  ...overrides,
});

describe('cost calculation', () => {
  it('prices input and output tokens independently', () => {
    // $3.00 per million in, $15.00 per million out.
    const cost = calculateCostMicros(
      { inputPriceMicros: 3_000_000, outputPriceMicros: 15_000_000 },
      1_000_000,
      1_000_000,
    );

    expect(cost).toBe(18_000_000);
    expect(formatMicros(cost)).toBe('$18.00');
  });

  it('scales below a full million tokens', () => {
    const cost = calculateCostMicros(
      { inputPriceMicros: 3_000_000, outputPriceMicros: 15_000_000 },
      500_000,
      100_000,
    );

    // 1.5 + 1.5 dollars
    expect(cost).toBe(3_000_000);
  });

  it('rounds partial micro-dollars up so spend is never undercounted', () => {
    const cost = calculateCostMicros({ inputPriceMicros: 1, outputPriceMicros: 0 }, 1, 0);

    expect(cost).toBe(1);
  });

  it('shows extra precision for sub-cent amounts', () => {
    // A plain 2-decimal format would collapse these to "$0.00".
    expect(formatMicros(882)).toBe('$0.0009');
    expect(formatMicros(0)).toBe('$0.00');
    expect(formatMicros(10_000)).toBe('$0.01');
  });

  it('treats unpriced models as free rather than throwing', () => {
    expect(
      calculateCostMicros({ inputPriceMicros: null, outputPriceMicros: null }, 5_000, 5_000),
    ).toBe(0);
  });

  it('prices one side when only the other is missing', () => {
    expect(
      calculateCostMicros({ inputPriceMicros: 2_000_000, outputPriceMicros: null }, 1_000_000, 500),
    ).toBe(2_000_000);
  });

  it('ignores negative token counts', () => {
    expect(
      calculateCostMicros({ inputPriceMicros: 3_000_000, outputPriceMicros: 3_000_000 }, -10, -10),
    ).toBe(0);
  });
});

describe('metric selection', () => {
  const totals = { messages: 7, tokens: 1_234, costMicros: 250_000 };

  it.each([
    ['messages', 7],
    ['tokens', 1_234],
    ['cost', 250_000],
  ] as const)('reads the %s metric', (metric, expected) => {
    expect(usedForMetric(metric, totals)).toBe(expected);
  });
});

describe('allowance reporting', () => {
  it('reports remaining allowance and reset time', () => {
    const resetsAt = new Date('2026-06-16T00:00:00Z');
    const allowance = buildAllowance(
      policy(),
      { messages: 40, tokens: 0, costMicros: 0 },
      resetsAt,
    );

    expect(allowance).toMatchObject({
      used: 40,
      limitValue: 100,
      remaining: 60,
      exceeded: false,
      resetsAt: '2026-06-16T00:00:00.000Z',
    });
  });

  it('never reports negative remaining allowance', () => {
    const allowance = buildAllowance(policy(), { messages: 150, tokens: 0, costMicros: 0 }, null);

    expect(allowance.remaining).toBe(0);
    expect(allowance.exceeded).toBe(true);
  });

  it('treats exactly reaching the limit as exceeded', () => {
    const allowance = buildAllowance(policy(), { messages: 100, tokens: 0, costMicros: 0 }, null);

    expect(allowance.exceeded).toBe(true);
  });
});

describe('limit messages', () => {
  it('formats a cost limit in dollars', () => {
    const message = limitMessage(
      policy({ metric: 'cost', limitValue: 5 * MICROS_PER_DOLLAR, windowKind: 'monthly' }),
    );

    expect(message).toContain('$5.00');
    expect(message).toContain('this month');
  });

  it('describes a rolling window by length', () => {
    const message = limitMessage(policy({ windowKind: 'rolling', windowHours: 6 }));

    expect(message).toContain('the last 6 hours');
  });
});

describe('policy input validation', () => {
  const base = {
    name: 'Daily cap',
    metric: 'messages',
    limitValue: 100,
    windowKind: 'daily',
    timezone: 'UTC',
    enabled: true,
    roles: ['user'],
  };

  it('accepts a calendar policy without windowHours', () => {
    expect(upsertQuotaPolicySchema.safeParse(base).success).toBe(true);
  });

  it('requires windowHours for rolling policies', () => {
    const result = upsertQuotaPolicySchema.safeParse({ ...base, windowKind: 'rolling' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['windowHours']);
  });

  it.each([0, -1, 1.5])('rejects a limit of %s', (limitValue) => {
    expect(upsertQuotaPolicySchema.safeParse({ ...base, limitValue }).success).toBe(false);
  });

  it.each(['requests', 'dollars', ''])('rejects unknown metric %j', (metric) => {
    expect(upsertQuotaPolicySchema.safeParse({ ...base, metric }).success).toBe(false);
  });

  it('rejects unknown roles', () => {
    expect(upsertQuotaPolicySchema.safeParse({ ...base, roles: ['owner'] }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(upsertQuotaPolicySchema.safeParse({ ...base, bypass: true }).success).toBe(false);
  });
});
