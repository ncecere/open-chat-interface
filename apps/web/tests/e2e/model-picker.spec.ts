import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

test('model picker keeps its size while filtering and is keyboard reachable', async ({ page }) => {
  await signIn(page);

  const trigger = page.getByRole('combobox', { name: /Select model/ });
  await trigger.click();

  const popup = page.getByLabel('Choose a model');
  const search = page.getByRole('textbox', { name: 'Search models' });
  await expect(popup).toBeVisible();
  await expect(search).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Filter models' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'All labs' })).toBeFocused();

  const firstLab = popup.locator('fieldset button:not([aria-label="All labs"])').first();
  test.skip((await firstLab.count()) === 0, 'At least two configured model labs are required');

  const before = await popup.boundingBox();
  await firstLab.click();
  const after = await popup.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
});
