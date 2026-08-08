import {
  USAGE_CRITICAL_THRESHOLD,
  USAGE_WARNING_THRESHOLD,
  type UsageAllowance,
} from '@oci/shared';
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
 * Mirrors the announcement rule: a policy is toasted when it first reaches a
 * severity, and again only if it worsens. Recovery clears the record so the
 * next approach warns again.
 */
function announce(
  seen: Map<string, UsageAllowance['severity']>,
  allowances: UsageAllowance[],
): string[] {
  const raised: string[] = [];

  for (const entry of allowances) {
    if (entry.severity === 'ok') {
      seen.delete(entry.policyId);
      continue;
    }
    if (seen.get(entry.policyId) === entry.severity) continue;
    seen.set(entry.policyId, entry.severity);
    raised.push(entry.policyId);
  }

  return raised;
}

describe('usage warning announcements', () => {
  it('stays silent while every allowance is healthy', () => {
    const seen = new Map<string, UsageAllowance['severity']>();
    expect(announce(seen, [allowance(), allowance({ policyId: 'policy-2' })])).toEqual([]);
  });

  it('announces a policy once rather than on every poll', () => {
    const seen = new Map<string, UsageAllowance['severity']>();
    const warning = [allowance({ severity: 'warning' })];

    expect(announce(seen, warning)).toEqual(['policy-1']);
    // Polling continues; the toast must not reappear unprompted.
    expect(announce(seen, warning)).toEqual([]);
  });

  it('announces again when the situation gets worse', () => {
    const seen = new Map<string, UsageAllowance['severity']>();

    announce(seen, [allowance({ severity: 'warning' })]);
    expect(announce(seen, [allowance({ severity: 'critical' })])).toEqual(['policy-1']);
    expect(announce(seen, [allowance({ severity: 'exceeded' })])).toEqual(['policy-1']);
  });

  it('warns again after a window resets and the user approaches the limit anew', () => {
    const seen = new Map<string, UsageAllowance['severity']>();

    announce(seen, [allowance({ severity: 'critical' })]);
    announce(seen, [allowance({ severity: 'ok' })]);
    expect(announce(seen, [allowance({ severity: 'warning' })])).toEqual(['policy-1']);
  });

  it('announces each policy independently', () => {
    const seen = new Map<string, UsageAllowance['severity']>();

    expect(
      announce(seen, [
        allowance({ policyId: 'anthropic', severity: 'warning' }),
        allowance({ policyId: 'openai', severity: 'exceeded' }),
      ]),
    ).toEqual(['anthropic', 'openai']);
  });

  it('uses thresholds that leave room to act before the cutoff', () => {
    // A warning that only appeared at the limit would be useless.
    expect(USAGE_WARNING_THRESHOLD).toBeLessThan(1);
    expect(USAGE_CRITICAL_THRESHOLD).toBeLessThan(1);
    expect(USAGE_WARNING_THRESHOLD).toBeLessThan(USAGE_CRITICAL_THRESHOLD);
  });
});
