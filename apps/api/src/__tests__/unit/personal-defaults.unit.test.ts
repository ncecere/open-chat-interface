import type { CatalogModel } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  assertPersonalDefaultsAllowed,
  resolvePersonalDefaults,
} from '../../services/personal-defaults.js';

/**
 * A person's default model and reasoning level (v0.10): which saved values
 * apply, and which changes are refused. The role's catalog already narrows
 * each model's levels to the role's.
 */
const catalog = [
  { slug: 'plain', displayName: 'Plain', capabilities: [], supportedEfforts: [] },
  {
    slug: 'thinker',
    displayName: 'Thinker',
    capabilities: ['effort_control'],
    supportedEfforts: ['instant', 'low', 'high'],
  },
  // Effort control without listed levels means every level.
  { slug: 'open', displayName: 'Open', capabilities: ['effort_control'], supportedEfforts: [] },
] as unknown as CatalogModel[];
const roleEfforts = ['instant', 'low', 'medium', 'high'] as const;

describe('resolvePersonalDefaults', () => {
  const context = { catalog, roleEfforts: [...roleEfforts], instanceEffort: 'low' as const };

  it('uses the instance defaults when nothing is saved', () => {
    expect(
      resolvePersonalDefaults({ defaultModelSlug: null, defaultEffort: null }, context),
    ).toEqual({ modelSlug: null, effort: 'low', problems: [] });
  });

  it('applies saved values the role and model allow', () => {
    expect(
      resolvePersonalDefaults({ defaultModelSlug: 'thinker', defaultEffort: 'high' }, context),
    ).toEqual({ modelSlug: 'thinker', effort: 'high', problems: [] });
    // Instant is always allowed, even on a model without levels.
    expect(
      resolvePersonalDefaults({ defaultModelSlug: 'plain', defaultEffort: 'instant' }, context),
    ).toEqual({ modelSlug: 'plain', effort: 'instant', problems: [] });
    expect(
      resolvePersonalDefaults({ defaultModelSlug: 'open', defaultEffort: 'medium' }, context)
        .effort,
    ).toBe('medium');
  });

  it('ignores and reports what no longer applies', () => {
    expect(
      resolvePersonalDefaults({ defaultModelSlug: 'retired', defaultEffort: 'medium' }, context),
    ).toEqual({ modelSlug: null, effort: 'medium', problems: ['model'] });
    expect(
      resolvePersonalDefaults({ defaultModelSlug: 'thinker', defaultEffort: 'medium' }, context),
    ).toEqual({ modelSlug: 'thinker', effort: 'low', problems: ['effort'] });
    expect(
      resolvePersonalDefaults(
        { defaultModelSlug: null, defaultEffort: 'high' },
        { ...context, roleEfforts: ['instant', 'low'] },
      ),
    ).toEqual({ modelSlug: null, effort: 'low', problems: ['effort'] });
    // Without the catalog a saved model cannot be confirmed.
    expect(
      resolvePersonalDefaults(
        { defaultModelSlug: 'thinker', defaultEffort: null },
        { ...context, catalog: null },
      ).problems,
    ).toEqual(['model']);
  });
});

describe('assertPersonalDefaultsAllowed', () => {
  const context = { catalog, roleEfforts: [...roleEfforts] };
  const check =
    (
      change: Parameters<typeof assertPersonalDefaultsAllowed>[0],
      next: Parameters<typeof assertPersonalDefaultsAllowed>[1],
      over: Partial<typeof context> = {},
    ) =>
    () =>
      assertPersonalDefaultsAllowed(change, next, { ...context, ...over });

  it('accepts what the role and model allow, and clearing', () => {
    expect(
      check(
        { defaultModelSlug: 'thinker', defaultEffort: 'high' },
        { defaultModelSlug: 'thinker', defaultEffort: 'high' },
      ),
    ).not.toThrow();
    expect(
      check(
        { defaultModelSlug: null, defaultEffort: null },
        { defaultModelSlug: null, defaultEffort: null },
      ),
    ).not.toThrow();
  });

  it('refuses a model the role may not use', () => {
    expect(
      check({ defaultModelSlug: 'hidden' }, { defaultModelSlug: 'hidden', defaultEffort: null }),
    ).toThrow('That model is not available to your role.');
  });

  it('refuses a level the role may not use', () => {
    expect(
      check(
        { defaultEffort: 'high' },
        { defaultModelSlug: null, defaultEffort: 'high' },
        { roleEfforts: ['instant'] },
      ),
    ).toThrow('The High reasoning level is not available to your role.');
  });

  it('refuses a pair the model does not offer, whichever side changed', () => {
    expect(
      check({ defaultEffort: 'medium' }, { defaultModelSlug: 'thinker', defaultEffort: 'medium' }),
    ).toThrow('Thinker does not offer the Medium reasoning level.');
    expect(
      check({ defaultModelSlug: 'plain' }, { defaultModelSlug: 'plain', defaultEffort: 'low' }),
    ).toThrow('Plain does not offer the Low reasoning level.');
  });

  it('does not refuse a level because a model saved earlier has since been hidden', () => {
    expect(
      check({ defaultEffort: 'low' }, { defaultModelSlug: 'retired', defaultEffort: 'low' }),
    ).not.toThrow();
  });
});
