import { expect, type Page, test } from '@playwright/test';
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

  { route: '/admin/invites', heading: 'Invitations', name: 'admin-invitations' },
  { route: '/admin/rate-limits', heading: 'Rate limits', name: 'admin-rate-limits' },
  { route: '/admin/storage-limits', heading: 'Storage limits', name: 'admin-storage-limits' },

  { route: '/admin/providers', heading: 'Providers & keys', name: 'admin-providers' },
  { route: '/admin/models', heading: 'Model catalog', name: 'admin-models' },
  { route: '/admin/quotas', heading: 'Usage budgets', name: 'admin-quotas' },

  {
    route: '/admin/settings/authentication',
    heading: 'Authentication',
    name: 'admin-settings-authentication',
  },
  { route: '/admin/sso', heading: 'Single sign-on', name: 'admin-sso' },
  { route: '/admin/settings/email', heading: 'Email delivery', name: 'admin-settings-email' },
  { route: '/admin/policies', heading: 'Acceptable use', name: 'admin-policies' },

  { route: '/admin/storage', heading: 'Storage', name: 'admin-storage' },
  { route: '/admin/retention', heading: 'Retention', name: 'admin-retention' },
  { route: '/admin/maintenance', heading: 'Maintenance', name: 'admin-maintenance' },
  { route: '/admin/health', heading: 'Health', name: 'admin-health' },

  { route: '/admin/usage', heading: 'Usage', name: 'admin-usage' },
  { route: '/admin/reports', heading: 'Scheduled reports', name: 'admin-reports' },
  { route: '/admin/audit', heading: 'Audit log', name: 'admin-audit' },

  // The General settings page keeps the historical image name.
  { route: '/admin/settings/general', heading: 'General', name: 'admin-settings' },
  { route: '/admin/branding', heading: 'Branding', name: 'admin-branding' },
  { route: '/admin/broadcasts', heading: 'Announcements', name: 'admin-announcements' },
  { route: '/admin/search', heading: 'Web search', name: 'admin-search' },
];

/**
 * The listing keeps previous rows visible while it refetches. Wait for the
 * sorted response so captures and row selection do not use the old order.
 */
async function sortUsersByThreads(page: Page): Promise<void> {
  const sorted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/admin/users' &&
      url.searchParams.get('sort') === 'threads' &&
      url.searchParams.get('direction') === 'desc' &&
      response.ok()
    );
  });
  await page.getByRole('button', { name: /threads/i }).click();
  await sorted;
  await expect(page.getByRole('columnheader', { name: /threads/i })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
}

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
    await sortUsersByThreads(page);
    await capture(page, 'admin-users');
  });

  test('captures a user detail', async ({ page }) => {
    await gotoAdmin(page, '/admin/users', 'Users');
    await sortUsersByThreads(page);

    // Somebody other than the account doing the capturing: photographing the
    // administrator shows a column of that session's own sign-ins rather than
    // what the page looks like for a person being investigated.
    const row = page
      .locator('tbody a[href*="/admin/users/"]')
      .filter({ hasNotText: 'Administrator' })
      .first();
    await expect(row).toBeVisible();
    const name = (await row.innerText()).trim();
    const href = await row.getAttribute('href');
    if (!name || !href) throw new Error('A seeded user detail link is required');
    const target = new URL(href, page.url()).href;
    await row.click();
    // The old listing heading can remain visible while the detail route loads.
    await expect(page).toHaveURL(target);
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'All users', exact: true })).toBeVisible();
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
    await gotoAdmin(page, '/admin/sso', 'Single sign-on');
    await page
      .getByRole('button', { name: /add provider/i })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, 'admin-sso-provider-form');
  });
});
