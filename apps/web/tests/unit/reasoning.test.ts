import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { coerceReasoningEffort, reasoningEffortForRequest } from '../../src/lib/reasoning';

function model(
  supportedEfforts: ReasoningEffort[],
  capabilities: CatalogModel['capabilities'] = [],
): CatalogModel {
  return { supportedEfforts, capabilities } as CatalogModel;
}

describe('composer reasoning effort', () => {
  it('keeps a selected effort supported by the new model', () => {
    expect(coerceReasoningEffort(model(['low', 'high']), 'high')).toBe('high');
  });

  it('prefers instant when a model switch invalidates the selection', () => {
    expect(coerceReasoningEffort(model(['instant', 'low']), 'high')).toBe('instant');
  });

  it('uses the first supported level when instant is unavailable', () => {
    expect(coerceReasoningEffort(model(['medium', 'high']), 'instant')).toBe('medium');
  });

  it('omits effort for a model without effort control', () => {
    expect(reasoningEffortForRequest(model([]), 'instant')).toBeUndefined();
  });

  it('includes instant explicitly for a model that supports it', () => {
    expect(reasoningEffortForRequest(model(['instant', 'low']), 'instant')).toBe('instant');
  });

  it('supports older catalog entries that only set effort_control', () => {
    expect(reasoningEffortForRequest(model([], ['effort_control']), 'high')).toBe('high');
  });
});
