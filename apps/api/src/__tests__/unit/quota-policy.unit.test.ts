import { MICROS_PER_DOLLAR, quotaWindowPhrase, upsertQuotaPolicySchema } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAllowance,
  calculateCostMicros,
  describeLimit,
  describeWindow,
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
  modelSlugs: [],
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

/**
 * These render the numbers an administrator sets a policy against. They are no
 * longer reachable from a user-facing message, so they need their own coverage:
 * a wrong figure here silently misstates what a limit actually is.
 */
describe('administrative limit descriptions', () => {
  it('describes each metric in its own unit', () => {
    expect(describeLimit(policy({ metric: 'messages', limitValue: 1_500 }))).toBe('1,500 messages');
    expect(describeLimit(policy({ metric: 'tokens', limitValue: 40_000 }))).toBe('40,000 tokens');
    expect(describeLimit(policy({ metric: 'cost', limitValue: 5 * MICROS_PER_DOLLAR }))).toBe(
      '$5.00',
    );
  });

  it('falls back to the raw value for an unrecognized metric', () => {
    // Guards a metric added to the schema but not yet handled here.
    expect(describeLimit(policy({ metric: 'requests' as never, limitValue: 42 }))).toBe('42');
  });

  it('describes every window kind', () => {
    expect(describeWindow(policy({ windowKind: 'rolling', windowHours: 12 }))).toBe(
      'the last 12 hours',
    );
    expect(describeWindow(policy({ windowKind: 'daily' }))).toBe('today');
    expect(describeWindow(policy({ windowKind: 'weekly' }))).toBe('this week');
    expect(describeWindow(policy({ windowKind: 'monthly' }))).toBe('this month');
    expect(describeWindow(policy({ windowKind: 'yearly' as never }))).toBe('this window');
  });

  it('says "the last hour" for a one-hour window, not "the last 1 hours" (#286)', () => {
    expect(describeWindow(policy({ windowKind: 'rolling', windowHours: 1 }))).toBe('the last hour');
    expect(quotaWindowPhrase('rolling', 1)).toBe('the last hour');
    expect(quotaWindowPhrase('rolling', 12)).toBe('the last 12 hours');
  });

  it('defaults a rolling window with no length to 24 hours', () => {
    expect(describeWindow(policy({ windowKind: 'rolling', windowHours: null }))).toBe(
      'the last 24 hours',
    );
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
  it('names what is counted and the window, never the administrator’s policy name (#93)', () => {
    const name = 'Walk AP race policy (users, non-biting)';
    expect(limitMessage(policy({ name, metric: 'cost', windowKind: 'monthly' }))).toBe(
      'You have reached your usage limit for this month.',
    );
    expect(limitMessage(policy({ name, metric: 'messages', windowKind: 'daily' }))).toBe(
      'You have reached your message limit for today.',
    );
    expect(limitMessage(policy({ name, metric: 'tokens', windowKind: 'weekly' }))).not.toContain(
      name,
    );
  });

  it('never exposes the underlying spend figure to a user', () => {
    const message = limitMessage(
      policy({ metric: 'cost', limitValue: 5 * MICROS_PER_DOLLAR, windowKind: 'monthly' }),
    );

    // Spend is instance cost, not something a user should be shown.
    expect(message).not.toContain('$');
    expect(message).not.toContain('5000000');
  });

  it('never exposes raw message or token counts to a user', () => {
    expect(limitMessage(policy({ metric: 'messages', limitValue: 100 }))).not.toContain('100');
    expect(limitMessage(policy({ metric: 'tokens', limitValue: 50_000 }))).not.toContain('50,000');
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
