import { expect, test } from '@playwright/test';
import { capture, gotoAdmin, signIn } from './helpers';

/**
 * One capture per administrative page.
 *
 * Named after the route rather than the heading, so a renamed page is an
 * obvious diff rather than an image whose filename quietly stops matching
 * where it came from.
 */
const PAGES: { route: string; heading: string; name: string }[] = [
  { route: '/admin', heading: 'Overview', name: 'admin-overview' },
  { route: '/admin/settings', heading: 'Instance settings', name: 'admin-settings' },
  { route: '/admin/branding', heading: 'Branding', name: 'admin-branding' },
  { route: '/admin/broadcasts', heading: 'Announcements', name: 'admin-announcements' },

  { route: '/admin/invites', heading: 'Invitations', name: 'admin-invitations' },
  { route: '/admin/sso', heading: 'Auth & SSO', name: 'admin-sso' },
  { route: '/admin/policies', heading: 'Acceptable use', name: 'admin-policies' },
  { route: '/admin/providers', heading: 'Providers & Keys', name: 'admin-providers' },
  { route: '/admin/models', heading: 'Model catalog', name: 'admin-models' },
  { route: '/admin/usage', heading: 'Usage', name: 'admin-usage' },
  { route: '/admin/quotas', heading: 'Usage quotas', name: 'admin-quotas' },
  { route: '/admin/storage-limits', heading: 'Storage limits', name: 'admin-storage-limits' },
  { route: '/admin/rate-limits', heading: 'Rate limits', name: 'admin-rate-limits' },
  { route: '/admin/retention', heading: 'Retention', name: 'admin-retention' },
  { route: '/admin/reports', heading: 'Scheduled reports', name: 'admin-reports' },
  { route: '/admin/search', heading: 'Search', name: 'admin-search' },
  { route: '/admin/storage', heading: 'Storage', name: 'admin-storage' },
  { route: '/admin/health', heading: 'Health', name: 'admin-health' },
  { route: '/admin/maintenance', heading: 'Maintenance', name: 'admin-maintenance' },
  { route: '/admin/audit', heading: 'Audit log', name: 'admin-audit' },
];

test.describe('administration', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const entry of PAGES) {
    test(`captures ${entry.name}`, async ({ page }) => {
      await gotoAdmin(page, entry.route, entry.heading);
      await capture(page, entry.name);
    });
  }

  test('captures the user listing', async ({ page }) => {
    await gotoAdmin(page, '/admin/users', 'Users');

    // Sorted by activity rather than the default, so the columns that describe
    // usage are not a column of zeroes belonging to the least active accounts.
    await page.getByRole('button', { name: /threads/i }).click();
    await expect(page.getByRole('columnheader', { name: /threads/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await capture(page, 'admin-users');
  });

  test('captures a user detail', async ({ page }) => {
    await gotoAdmin(page, '/admin/users', 'Users');
    await page.getByRole('button', { name: /threads/i }).click();

    // Somebody other than the account doing the capturing: photographing the
    // administrator shows a column of that session's own sign-ins rather than
    // what the page looks like for a person being investigated.
    const rows = page.locator('tbody a[href*="/admin/users/"]');
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if ((await row.textContent())?.includes('Administrator')) continue;
      await row.click();
      break;
    }
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await capture(page, 'admin-user-detail');
  });

  test('captures the bulk action bar', async ({ page }) => {
    await gotoAdmin(page, '/admin/users', 'Users');

    const boxes = page.locator('tbody input[type="checkbox"]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(page.getByText(/accounts selected/)).toBeVisible();
    await capture(page, 'admin-users-bulk-actions');
  });

  test('captures the single sign-on provider form', async ({ page }) => {
    await gotoAdmin(page, '/admin/sso', 'Auth & SSO');
    await page
      .getByRole('button', { name: /add provider/i })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, 'admin-sso-provider-form');
  });
});
