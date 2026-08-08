import { describe, expect, it } from 'vitest';
import {
  type EvaluablePolicy,
  limitMessage,
  policyCoversModel,
} from '../../services/quota/policy.js';

const policy = (overrides: Partial<EvaluablePolicy> = {}): EvaluablePolicy => ({
  id: 'policy-1',
  name: 'Anthropic models',
  metric: 'cost',
  limitValue: 5_000_000,
  windowKind: 'monthly',
  windowHours: null,
  timezone: 'UTC',
  modelSlugs: [],
  ...overrides,
});

describe('model-scoped policies', () => {
  it('treats an empty scope as every model', () => {
    const unscoped = policy();
    expect(policyCoversModel(unscoped, 'claude-sonnet-4-6')).toBe(true);
    expect(policyCoversModel(unscoped, 'gpt-5-6')).toBe(true);
  });

  it('only governs the models it names', () => {
    const scoped = policy({ modelSlugs: ['claude-sonnet-4-6', 'claude-opus-4-1'] });
    expect(policyCoversModel(scoped, 'claude-sonnet-4-6')).toBe(true);
    expect(policyCoversModel(scoped, 'claude-opus-4-1')).toBe(true);
    // A model in no policy is unlimited rather than denied.
    expect(policyCoversModel(scoped, 'gpt-5-6')).toBe(false);
  });

  it('lets separate families carry independent budgets', () => {
    const anthropic = policy({ modelSlugs: ['claude-sonnet-4-6'] });
    const openai = policy({ id: 'policy-2', name: 'OpenAI models', modelSlugs: ['gpt-5-6'] });

    const applicable = [anthropic, openai].filter((candidate) =>
      policyCoversModel(candidate, 'gpt-5-6'),
    );
    expect(applicable).toHaveLength(1);
    expect(applicable[0]?.name).toBe('OpenAI models');
  });

  it('tells a user other models remain available when a scoped budget is spent', () => {
    expect(limitMessage(policy({ modelSlugs: ['claude-sonnet-4-6'] }))).toContain(
      'Other models are still available',
    );
    // An instance-wide policy must not make that promise.
    expect(limitMessage(policy())).not.toContain('Other models are still available');
  });
});
