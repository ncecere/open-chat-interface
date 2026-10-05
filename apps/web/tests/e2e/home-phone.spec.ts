import { expect, type Page, test } from '@playwright/test';

/**
 * The new-chat page on a phone (#102): the greeting has room above the
 * centred composer, and the composer's menu opens below it rather than over
 * the greeting.
 */

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

test('the greeting is not crowded or covered by the composer on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const heading = page.getByRole('heading', { level: 1 });
  const options = page.getByRole('button', { name: 'More composer options' });
  const greeting = (await heading.boundingBox())!;
  const composer = (await page.getByRole('textbox', { name: 'Message input' }).boundingBox())!;
  expect(composer.y - (greeting.y + greeting.height)).toBeGreaterThanOrEqual(24);

  await options.click();
  const menu = (await page.getByRole('menu').boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(greeting.y + greeting.height);
});
