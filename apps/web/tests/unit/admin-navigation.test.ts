import { describe, expect, it } from 'vitest';
import {
  ADMIN_OVERVIEW,
  findActiveAdminNav,
  isAdminNavItemActive,
  NAV_SECTIONS,
} from '../../src/lib/admin-navigation';

describe('admin navigation catalogue', () => {
  it('keeps Overview first and ungrouped, then the six groups in order', () => {
    expect(ADMIN_OVERVIEW).toMatchObject({ to: '/admin', label: 'Overview' });
    expect(
      NAV_SECTIONS.map((section) => [
        section.label,
        section.items.map((item) => `${item.label} ${item.to}`),
      ]),
    ).toEqual([
      [
        'People',
        ['Users /admin/users', 'Invitations /admin/invites', 'Roles & access /admin/roles'],
      ],
      ['Models', ['Providers & Models /admin/models', 'Usage budgets /admin/quotas']],
      [
        'Sign-in & security',
        [
          'Authentication /admin/settings/authentication',
          'Email delivery /admin/settings/email',
          'Acceptable use /admin/policies',
        ],
      ],
      [
        'Data & storage',
        ['Storage /admin/storage', 'Retention /admin/retention', 'System health /admin/health'],
      ],
      ['Insights', ['Usage /admin/usage', 'Reports /admin/reports', 'Audit log /admin/audit']],
      [
        'Appearance & features',
        [
          'General /admin/settings/general',
          'Branding /admin/branding',
          'Announcements /admin/broadcasts',
          'Web search /admin/search',
        ],
      ],
    ]);
  });

  it('lists every destination once', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.to));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).not.toContain('/admin');
  });
});

describe('active state', () => {
  it('matches Overview only on its own page', () => {
    expect(isAdminNavItemActive('/admin', '/admin')).toBe(true);
    expect(isAdminNavItemActive('/admin/', '/admin')).toBe(true);
    expect(isAdminNavItemActive('/admin/users', '/admin')).toBe(false);
    expect(isAdminNavItemActive('/admin/settings/general', '/admin')).toBe(false);
  });

  it('matches nested pages at a segment boundary', () => {
    expect(isAdminNavItemActive('/admin/users', '/admin/users')).toBe(true);
    expect(isAdminNavItemActive('/admin/users/user-42', '/admin/users')).toBe(true);
    expect(isAdminNavItemActive('/admin/storage-limits', '/admin/storage')).toBe(false);
    expect(isAdminNavItemActive('/admin/settings/email', '/admin/settings/general')).toBe(false);
  });

  it('resolves the current item and its group', () => {
    expect(findActiveAdminNav('/admin/users/user-42')).toMatchObject({
      item: { label: 'Users' },
      section: { label: 'People' },
    });
    expect(findActiveAdminNav('/admin/settings/email')).toMatchObject({
      item: { label: 'Email delivery' },
      section: { label: 'Sign-in & security' },
    });
    expect(findActiveAdminNav('/admin')).toMatchObject({
      item: { label: 'Overview' },
      section: null,
    });
    expect(findActiveAdminNav('/settings')).toBeNull();
  });

  it('marks exactly one item active on every listed page', () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        const active = [ADMIN_OVERVIEW, ...NAV_SECTIONS.flatMap((entry) => entry.items)].filter(
          (candidate) => isAdminNavItemActive(item.to, candidate.to),
        );
        expect(active.map((candidate) => candidate.to)).toEqual([item.to]);
      }
    }
  });
});
