import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Settings → Account (v0.9.1) in a real browser against the real API: the
 * devices list and signing a device out, and a password change round trip.
 * The password is changed on a disposable account an administrator creates
 * for the test, never on the seeded administrator.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function adminCredentials() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

/**
 * A fresh local account, made through the administration API.
 *
 * The fixture requires verified addresses and cannot deliver mail, so the
 * requirement is lifted for the moment the account is created (an
 * administrator-created account is then verified) and restored at once.
 */
async function disposableUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const admin = adminCredentials();
  await signIn(page, admin.email, admin.password);
  const settings = await page.request.get('/api/admin/settings');
  expect(settings.ok()).toBe(true);
  const { emailVerificationRequired } = (await settings.json()) as {
    emailVerificationRequired: boolean;
  };
  const email = `settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = `Disposable-${Math.random().toString(36).slice(2, 10)}-Pw1!`;
  try {
    if (emailVerificationRequired) {
      const lifted = await page.request.patch('/api/admin/settings', {
        data: { emailVerificationRequired: false },
      });
      expect(lifted.ok(), await lifted.text()).toBe(true);
    }
    const response = await page.request.post('/api/admin/users', {
      data: { email, name: 'Settings Fixture', password, role: 'user' },
    });
    expect(response.status(), await response.text()).toBe(201);
  } finally {
    if (emailVerificationRequired) {
      const restored = await page.request.patch('/api/admin/settings', {
        data: { emailVerificationRequired: true },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
    await context.close();
  }
  return { email, password };
}

async function scan(page: Page) {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  );
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  return results.violations
    .map((violation) => `[${violation.impact}] ${violation.id}: ${violation.help}`)
    .join('\n');
}

test('lists devices, marks this one, and signs another out', async ({ browser }) => {
  const user = await disposableUser(browser);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, user.email, user.password);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'View Devices' }).click();

  const dialog = page.getByRole('dialog', { name: 'Devices' });
  const rows = dialog.getByTestId('account-session');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('This device');
  await expect(rows.nth(1)).not.toContainText('This device');
  expect(await scan(page)).toBe('');

  await rows
    .nth(1)
    .getByRole('button', { name: /^Sign out / })
    .click();
  await expect(dialog).toContainText('That device has been signed out.');
  await expect(rows).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Sign out all other devices' })).toBeDisabled();

  await other.close();
  await context.close();
});

test('changes a password and signs in with the new one', async ({ browser }) => {
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings');
  await expect(page.getByText('To delete your account, contact your administrator.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Account' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change Email' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Change Password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change password' });
  await expect(dialog).toBeVisible();
  expect(await scan(page)).toBe('');

  // A wrong current password is explained, and nothing changes.
  const next = `${user.password}-next`;
  await dialog.getByLabel('Current password').fill('Not-the-password-123');
  await dialog.getByLabel('New password', { exact: true }).fill(next);
  await dialog.getByLabel('Confirm new password').fill(next);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Your current password is not correct.');

  await dialog.getByLabel('Current password').fill(user.password);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    'Your password has been changed and your other devices have been signed out.',
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  // This device stays signed in.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await context.close();

  // The old password no longer works; the new one does.
  const fresh = await browser.newContext();
  const login = await fresh.newPage();
  await login.goto('/auth/login');
  await login.getByLabel('Email').fill(user.email);
  await login.getByLabel('Password').fill(user.password);
  await login.getByRole('button', { name: 'Sign in' }).click();
  await expect(login.getByText(/invalid email or password/i)).toBeVisible();
  await expect(login).toHaveURL(/\/auth\/login/);
  await signIn(login, user.email, next);
  await fresh.close();
});

test('edits the name of a password account', async ({ browser }) => {
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Edit name' }).click();
  await page.getByLabel('Name', { exact: true }).fill('  Renamed Fixture  ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Renamed Fixture').first()).toBeVisible();
  await context.close();
});
