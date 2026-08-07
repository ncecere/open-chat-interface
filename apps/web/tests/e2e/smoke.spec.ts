import { expect, test } from '@playwright/test';

test('anonymous users are redirected to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('invalid public shares fail without exposing private data', async ({ page }) => {
  await page.goto('/share/not-a-real-share');
  await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
  await expect(page.getByText(/private|reasoning|system prompt/i)).toHaveCount(0);
});

test('administrator can reach the chat composer', async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
});

test('mobile shell uses an accessible full-screen sidebar drawer', async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();
  await expect(page.locator('aside')).toHaveAttribute('aria-hidden', 'true');

  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation sidebar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('aside')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeFocused();
});
