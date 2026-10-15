import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP_TAB, GROUP_TABS, validateGroupSearch } from '../../src/lib/admin-search';

describe('validateGroupSearch', () => {
  it('lists the tabs the spec names, Members first', () => {
    expect(GROUP_TABS).toEqual(['members', 'grants', 'usage', 'settings']);
    expect(DEFAULT_GROUP_TAB).toBe('members');
  });

  it('keeps a known tab and leaves the default out of the address', () => {
    expect(validateGroupSearch({ tab: 'grants' })).toEqual({ tab: 'grants' });
    expect(validateGroupSearch({ tab: 'members' })).toEqual({});
    expect(validateGroupSearch({})).toEqual({});
  });

  it('drops a tab it does not know rather than showing nothing', () => {
    expect(validateGroupSearch({ tab: 'budgets' })).toEqual({});
    expect(validateGroupSearch({ tab: 7 })).toEqual({});
  });
});
