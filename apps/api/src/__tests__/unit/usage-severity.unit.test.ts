import { USAGE_CRITICAL_THRESHOLD, USAGE_WARNING_THRESHOLD } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  allowanceSeverity,
  buildAllowance,
  type EvaluablePolicy,
} from '../../services/quota/policy.js';

const policy: EvaluablePolicy = {
  id: 'policy-1',
  name: 'Daily messages',
  metric: 'messages',
  limitValue: 100,
  windowKind: 'daily',
  windowHours: null,
  timezone: 'UTC',
  modelSlugs: [],
};

describe('usage warning severity', () => {
  it('stays quiet well below the limit', () => {
    expect(allowanceSeverity(0, 100)).toBe('ok');
    expect(allowanceSeverity(79, 100)).toBe('ok');
  });

  it('warns at the configured threshold, not after', () => {
    expect(allowanceSeverity(USAGE_WARNING_THRESHOLD * 100, 100)).toBe('warning');
    expect(allowanceSeverity(94, 100)).toBe('warning');
  });

  it('escalates before the user is actually cut off', () => {
    expect(allowanceSeverity(USAGE_CRITICAL_THRESHOLD * 100, 100)).toBe('critical');
    expect(allowanceSeverity(99, 100)).toBe('critical');
  });

  it('reports exceeded only once the limit is reached', () => {
    expect(allowanceSeverity(100, 100)).toBe('exceeded');
    expect(allowanceSeverity(150, 100)).toBe('exceeded');
  });

  it('carries severity and model scope through the allowance', () => {
    const allowance = buildAllowance(
      { ...policy, modelSlugs: ['claude-sonnet-4-6'] },
      { messages: 85, tokens: 0, costMicros: 0 },
      null,
    );

    expect(allowance.severity).toBe('warning');
    expect(allowance.remaining).toBe(15);
    expect(allowance.modelSlugs).toEqual(['claude-sonnet-4-6']);
  });
});
