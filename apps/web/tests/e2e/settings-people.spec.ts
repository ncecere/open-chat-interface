import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * v0.10 settings for people in a real browser against the real API:
 * Settings → Sharing lists a person's links and revokes them, and Settings →
 * Models saves a default model with the account, and a person deletes their
 * own account. Each test uses a disposable account an administrator creates,
 * never the seeded administrator. Deleting your own account is switched on
 * for the restricted role only, which no other browser test reads; it is left
 * on because the desktop and phone runs of this file overlap.
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

/** A fresh local account (see settings-account.spec.ts for why verification is lifted). */
async function disposableUser(
  browser: Browser,
  role: 'user' | 'restricted' = 'user',
  before?: (admin: Page) => Promise<void>,
) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const adminPassword = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !adminPassword) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, adminPassword);
  await before?.(page);
  const settings = await page.request.get('/api/admin/settings');
  expect(settings.ok()).toBe(true);
  const { emailVerificationRequired } = (await settings.json()) as {
    emailVerificationRequired: boolean;
  };
  const user = {
    email: `people-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    password: `Disposable-${Math.random().toString(36).slice(2, 10)}-Pw1!`,
  };
  try {
    if (emailVerificationRequired) {
      const lifted = await page.request.patch('/api/admin/settings', {
        data: { emailVerificationRequired: false },
      });
      expect(lifted.ok(), await lifted.text()).toBe(true);
    }
    const response = await page.request.post('/api/admin/users', {
      data: { ...user, name: 'People Fixture', role },
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
  return user;
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

test('lists the person’s share links and revokes them all', async ({ browser }) => {
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);

  const created = await page.request.post('/api/threads', {
    data: { title: 'Shared from the test', temporary: false },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { thread } = (await created.json()) as { thread: { id: string } };
  for (let index = 0; index < 2; index += 1) {
    const shared = await page.request.post(`/api/share-links/threads/${thread.id}`, { data: {} });
    expect(shared.status(), await shared.text()).toBe(201);
  }

  await page.goto('/settings/sharing');
  await expect(page.getByRole('heading', { level: 1, name: 'Sharing' })).toBeVisible();
  const rows = page.getByTestId('share-link');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Shared from the test');
  await expect(rows.first()).toContainText('Live');
  await expect(rows.first().getByRole('link', { name: 'Shared from the test' })).toHaveAttribute(
    'href',
    `/chat/${thread.id}`,
  );
  expect(await scan(page)).toBe('');

  await page.getByRole('button', { name: 'Revoke all' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke all 2 share links?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Revoke all' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('2 links have been revoked.')).toBeVisible();
  await expect(rows.filter({ hasText: 'Revoked' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Revoke all' })).toBeDisabled();
  await context.close();
});

test('saves a default model with the account', async ({ browser }) => {
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);

  const catalog = await page.request.get('/api/models');
  const { models } = (await catalog.json()) as {
    models: Array<{ slug: string; displayName: string; isDefault: boolean }>;
  };
  expect(models.length).toBeGreaterThan(0);
  const chosen = models.find((model) => !model.isDefault) ?? models[0]!;

  await page.goto('/settings/models');
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Default model' }).click();
  await page.getByRole('option', { name: chosen.displayName, exact: true }).click();
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect(await scan(page)).toBe('');

  const me = await page.request.get('/api/me');
  const body = (await me.json()) as {
    preferences: { defaultModelSlug: string | null };
    chat: { defaultModelSlug: string | null };
  };
  expect(body.preferences.defaultModelSlug).toBe(chosen.slug);
  expect(body.chat.defaultModelSlug).toBe(chosen.slug);

  // Another browser (a new device) starts from it too.
  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second, user.email, user.password);
  await second.goto('/settings/models');
  await expect(second.getByRole('combobox', { name: 'Default model' })).toContainText(
    chosen.displayName,
  );
  await other.close();
  await context.close();
});

test('a person deletes their own account when their role allows it', async ({ browser }) => {
  const user = await disposableUser(browser, 'restricted', async (admin) => {
    const allowed = await admin.request.put('/api/admin/roles/restricted', {
      data: { accountDeletion: true },
    });
    expect(allowed.ok(), await allowed.text()).toBe(true);
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);

  await page.goto('/settings');
  await expect(page.getByText('To delete your account, contact your administrator.')).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog).toContainText('The audit log keeps every entry');
  await expect(dialog).toContainText(
    'Usage records (messages, tokens and cost per model) are kept without anything that identifies you',
  );
  const confirm = dialog.getByRole('button', { name: 'Delete my account' });
  await expect(confirm).toBeDisabled();
  expect(await scan(page)).toBe('');

  await dialog.getByLabel(`Type ${user.email} to confirm`).fill(user.email);
  await dialog.getByLabel('Your password').fill('not-the-password-1!');
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText('Your password is not correct.');

  await dialog.getByLabel('Your password').fill(user.password);
  await confirm.click();
  await expect(page).toHaveURL(/\/auth\/login/);

  // The account is gone: signing in again is refused.
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/login/);
  await context.close();
});
