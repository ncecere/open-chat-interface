import type { UsageAllowance } from '@oci/shared';
import { describe, expect, it } from 'vitest';

const allowance = (overrides: Partial<UsageAllowance> = {}): UsageAllowance => ({
  policyId: 'policy-1',
  name: 'Anthropic models',
  metric: 'cost',
  windowKind: 'monthly',
  windowHours: null,
  used: 0,
  limitValue: 5_000_000,
  remaining: 5_000_000,
  exceeded: false,
  resetsAt: null,
  modelSlugs: [],
  severity: 'ok',
  ...overrides,
});

/**
 * Mirrors the meter and toast: how much of an allowance is left, as a whole
 * percentage. Messages, tokens, and spend are three different units, so a
 * percentage is the one reading that works for all of them.
 */
function percentRemaining(entry: UsageAllowance): number {
  const fraction = Math.max(0, 1 - entry.used / entry.limitValue);
  return fraction > 0 ? Math.max(1, Math.floor(fraction * 100)) : 0;
}

describe('usage percentage', () => {
  it('reads 100% before anything is used', () => {
    expect(percentRemaining(allowance())).toBe(100);
  });

  it('reads the same way regardless of the underlying unit', () => {
    const spend = allowance({ metric: 'cost', limitValue: 5_000_000, used: 1_250_000 });
    const messages = allowance({ metric: 'messages', limitValue: 100, used: 25 });
    const tokens = allowance({ metric: 'tokens', limitValue: 40_000, used: 10_000 });

    expect(percentRemaining(spend)).toBe(75);
    expect(percentRemaining(messages)).toBe(75);
    expect(percentRemaining(tokens)).toBe(75);
  });

  it('rounds down so a nearly spent allowance is not flattered', () => {
    // 1.8% left must not read as 2%.
    expect(percentRemaining(allowance({ limitValue: 1_000, used: 982 }))).toBe(1);
  });

  it('keeps a still-usable allowance visible rather than showing zero', () => {
    // Rounding alone would report 0% while the user can still send.
    expect(percentRemaining(allowance({ limitValue: 1_000_000, used: 999_999 }))).toBe(1);
  });

  it('reads 0% only once the allowance is genuinely spent', () => {
    expect(percentRemaining(allowance({ limitValue: 100, used: 100 }))).toBe(0);
    // Settlement can overshoot slightly; that must not go negative.
    expect(percentRemaining(allowance({ limitValue: 100, used: 130 }))).toBe(0);
  });
});
