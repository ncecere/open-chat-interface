import { describe, expect, it } from 'vitest';
import {
  applySavedUserFilters,
  savedUserFilters,
  type UserDirectoryFilters,
  userListParams,
} from '../../src/routes/admin/users/directory-filters';
import { selectUserPage } from '../../src/routes/admin/users/use-user-selection';

const defaults: UserDirectoryFilters = {
  search: '',
  role: 'all',
  status: 'all',
  sort: 'created',
  direction: 'desc',
};

describe('admin user directory filters', () => {
  it('keeps the default query and fifty-row offset without all-filter parameters', () => {
    expect(userListParams(defaults, 2).toString()).toBe(
      'sort=created&direction=desc&limit=50&offset=100',
    );
  });

  it('sends raw search text and active filters to the API', () => {
    expect(
      Object.fromEntries(
        userListParams(
          { ...defaults, search: ' Alice & Bob ', role: 'auditor', status: 'unverified' },
          0,
        ),
      ),
    ).toEqual({
      sort: 'created',
      direction: 'desc',
      limit: '50',
      offset: '0',
      search: ' Alice & Bob ',
      role: 'auditor',
      status: 'unverified',
    });
  });

  it('trims saved search only, omits inactive filters and never saves the page', () => {
    expect(savedUserFilters({ ...defaults, search: '   ' })).toEqual({
      sort: 'created',
      direction: 'desc',
    });
    expect(
      savedUserFilters({
        ...defaults,
        search: ' Alice ',
        role: 'restricted',
        status: 'banned',
        sort: 'threads',
        direction: 'asc',
      }),
    ).toEqual({
      search: 'Alice',
      role: 'restricted',
      status: 'banned',
      sort: 'threads',
      direction: 'asc',
    });
  });

  it('resets omitted filters while retaining unspecified sorting on view application', () => {
    const current: UserDirectoryFilters = {
      search: 'previous',
      role: 'admin',
      status: 'banned',
      sort: 'name',
      direction: 'asc',
    };
    expect(applySavedUserFilters(current, {})).toEqual({
      ...defaults,
      sort: 'name',
      direction: 'asc',
    });
    expect(
      applySavedUserFilters(current, { role: 'auditor', sort: 'messages', direction: 'desc' }),
    ).toEqual({ ...defaults, role: 'auditor', sort: 'messages', direction: 'desc' });
  });
});

describe('admin user page selection', () => {
  it('adds and removes the visible page without touching other pages or the previous set', () => {
    const original = new Set(['other-page', 'page-a']);
    const selected = selectUserPage(original, ['page-a', 'page-b'], true);
    expect([...selected]).toEqual(['other-page', 'page-a', 'page-b']);
    expect([...selectUserPage(selected, ['page-a', 'page-b'], false)]).toEqual(['other-page']);
    expect([...original]).toEqual(['other-page', 'page-a']);
  });

  it('does not clear off-page selections when the page is empty', () => {
    expect([...selectUserPage(new Set(['other-page']), [], false)]).toEqual(['other-page']);
  });
});
