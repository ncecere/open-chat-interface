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
 * Mirrors the banner's selection rule: warn on anything that is not ok, and
 * lead with the most urgent allowance so the message stays actionable.
 */
function mostUrgent(allowances: UsageAllowance[]): UsageAllowance | undefined {
  const order: Record<UsageAllowance['severity'], number> = {
    exceeded: 0,
    critical: 1,
    warning: 2,
    ok: 3,
  };

  return [...allowances]
    .filter((entry) => entry.severity !== 'ok')
    .sort((a, b) => order[a.severity] - order[b.severity])[0];
}

describe('usage warning selection', () => {
  it('stays hidden while every allowance is healthy', () => {
    expect(mostUrgent([allowance(), allowance({ policyId: 'policy-2' })])).toBeUndefined();
  });

  it('surfaces an exceeded policy ahead of a merely warning one', () => {
    const shown = mostUrgent([
      allowance({ policyId: 'warning', severity: 'warning' }),
      allowance({ policyId: 'spent', severity: 'exceeded' }),
    ]);

    expect(shown?.policyId).toBe('spent');
  });

  it('prefers critical over warning when nothing is exceeded', () => {
    const shown = mostUrgent([
      allowance({ policyId: 'warning', severity: 'warning' }),
      allowance({ policyId: 'critical', severity: 'critical' }),
    ]);

    expect(shown?.policyId).toBe('critical');
  });

  it('uses thresholds that leave room to act before the cutoff', () => {
    // A warning that only appears at the limit would be useless.
    expect(USAGE_WARNING_THRESHOLD).toBeLessThan(1);
    expect(USAGE_CRITICAL_THRESHOLD).toBeLessThan(1);
    expect(USAGE_WARNING_THRESHOLD).toBeLessThan(USAGE_CRITICAL_THRESHOLD);
  });

  it('carries the model scope so the message can name what is still available', () => {
    const scoped = allowance({ severity: 'exceeded', modelSlugs: ['claude-sonnet-4-6'] });
    expect(mostUrgent([scoped])?.modelSlugs).toEqual(['claude-sonnet-4-6']);
  });
});
