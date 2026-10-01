import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  // These tests enter admin routes directly, outside the chat onboarding gate.
}

test.beforeEach(async ({ page }) => signIn(page));

test('storage tabs retain one draft and submit only changed public settings', async ({ page }) => {
  const response = await page.request.get('/api/admin/settings');
  expect(response.ok()).toBe(true);
  const initial = await response.json();
  const patches: unknown[] = [];
  await page.route('**/api/admin/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: initial });
  });

  await page.goto('/admin/storage');
  await page.getByRole('tab', { name: 'Upload policy' }).click();
  const nextLimit = String(initial.storage.maxFilesPerMessage + 1);
  await page.getByLabel('Maximum files per message').fill(nextLimit);
  await page.getByRole('tab', { name: 'S3 connection' }).click();
  // The tab is in the URL, but switching must not remount the shared draft.
  await expect(page).toHaveURL(/[?&]tab=s3\b/);
  await expect(page.getByRole('button', { name: 'Check bucket access' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Upload policy' }).click();
  await expect(page).toHaveURL(/[?&]tab=uploads\b/);
  await expect(page.getByLabel('Maximum files per message')).toHaveValue(nextLimit);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Storage settings saved.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ storage: { maxFilesPerMessage: Number(nextLimit) } }]);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
});

for (const kind of ['oidc', 'saml'] as const) {
  test(`SSO ${kind} creation submits only the selected protocol and access policy`, async ({
    page,
  }) => {
    const submissions: Record<string, unknown>[] = [];
    await page.route('**/api/admin/sso/providers', async (route) => {
      if (route.request().method() === 'POST') {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ json: { providerId: 'review-sso' } });
      }
      return route.fulfill({ json: { providers: [] } });
    });
    // Single sign-on lives on the Authentication page; the old address redirects there.
    await page.goto('/admin/sso');
    await expect(page).toHaveURL(/\/admin\/settings\/authentication#single-sign-on$/);
    await page
      .locator('#single-sign-on')
      .getByRole('button', { name: 'Add provider', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    if (kind === 'saml') {
      await dialog.getByRole('combobox', { name: 'Provider type' }).click();
      await page.getByRole('option', { name: 'SAML 2.0', exact: true }).click();
      await dialog.getByLabel('IdP entity ID / issuer').fill('https://id.example.test');
      await dialog.getByLabel('Single sign-on URL').fill('https://id.example.test/sso');
      await dialog
        .getByLabel('IdP signing certificate')
        .fill('-----BEGIN CERTIFICATE-----\nreview-only\n-----END CERTIFICATE-----');
    } else {
      await dialog.getByLabel('Issuer URL').fill('https://id.example.test');
      await dialog.getByLabel('Client ID', { exact: true }).fill('review-client');
      await dialog
        .getByLabel('Client secret', { exact: true })
        .fill('review-only-not-a-credential');
    }
    await dialog.getByLabel('Provider ID', { exact: true }).fill('review-sso');
    await dialog.locator('#sso-label').fill('Review SSO');
    await dialog.getByLabel('Allowed email domains').fill('EXAMPLE.TEST, example.test');
    await dialog.getByRole('button', { name: 'Add provider', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      providerId: 'review-sso',
      kind,
      label: 'Review SSO',
      allowedDomains: ['example.test', 'example.test'],
    });
    // The form currently deduplicates before lowercasing; preserve that request
    // shape here rather than smuggling a normalization change into a refactor.
    if (kind === 'oidc') {
      expect(submissions[0]).toHaveProperty('clientSecret', 'review-only-not-a-credential');
      expect(submissions[0]).not.toHaveProperty('idpCertificate');
    } else {
      expect(submissions[0]).toHaveProperty('idpCertificate');
      expect(submissions[0]).not.toHaveProperty('clientSecret');
    }
  });
}

test('user filters reset pagination and selection survives page changes', async ({ page }) => {
  const requests: URL[] = [];
  const bulkRequests: unknown[] = [];
  const user = (id: string) => ({
    id,
    name: `Review ${id}`,
    email: `${id}@example.test`,
    image: null,
    role: 'user',
    emailVerified: true,
    banned: false,
    banReason: null,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    threadCount: 0,
    messageCount: 0,
  });
  await page.route(/\/api\/admin\/users\?/, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const offset = Number(url.searchParams.get('offset'));
    return route.fulfill({ json: { users: [user(offset === 0 ? 'first' : 'second')], total: 51 } });
  });
  await page.route('**/api/admin/users/bulk', async (route) => {
    bulkRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { affected: 2, skippedSelf: false } });
  });
  await page.goto('/admin/users');
  await page.getByLabel('Select first@example.test', { exact: true }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Select second@example.test', { exact: true }).check();
  await expect(page.getByText('2 accounts selected', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Search by name or email...').fill('review');
  await expect(page.getByLabel('Select first@example.test', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get('offset')).toBe('0');
  expect(requests.at(-1)?.searchParams.get('search')).toBe('review');
  await page.getByRole('button', { name: 'Apply role', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toBeHidden();
  expect(bulkRequests).toEqual([
    { userIds: ['first', 'second'], action: 'set_role', role: 'user' },
  ]);
});

test('instance settings live at their own addresses', async ({ page, isMobile }) => {
  await page.goto('/admin/settings');
  await expect(page).toHaveURL(/\/admin\/settings\/general$/);
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  // Narrow screens keep the navigation in a drawer behind the menu button.
  if (isMobile) await page.getByRole('button', { name: 'Open admin navigation' }).click();
  const nav = page.getByRole('navigation', { name: 'Administration' });
  await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByRole('link', { name: 'Overview', exact: true })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav.getByRole('link', { name: 'Email delivery', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/email$/);
  await expect(page.getByRole('heading', { name: 'Email delivery', level: 1 })).toBeVisible();
});

test('merged pages redirect to the page that now owns them', async ({ page }) => {
  for (const [from, to, heading] of [
    ['/admin/providers', /\/admin\/models$/, 'Providers & models'],
    ['/admin/rate-limits', /\/admin\/roles$/, 'Roles & access'],
    ['/admin/storage-limits', /\/admin\/roles$/, 'Roles & access'],
    ['/admin/maintenance', /\/admin\/health$/, 'System health'],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('Roles & access keeps the selected role in the URL', async ({ page }) => {
  await page.goto('/admin/roles?role=restricted');
  await expect(page.getByRole('tab', { name: 'Restricted', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Admin', exact: true }).click();
  await expect(page).toHaveURL(/[?&]role=admin\b/);
  await expect(page.getByLabel('Messages per minute')).toBeVisible();
});
