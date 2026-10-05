import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Popups with the ARIA their roles require (#114): the model picker's
 * listbox held non-option children, the attachments filter used menuitem
 * with aria-checked, and Select listboxes had no name.
 */

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

const RULES = ['aria-required-children', 'aria-allowed-attr', 'aria-input-field-name'];

async function violations(page: Page, selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).withRules(RULES).analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

test('the model picker, attachments filter and Select popups have valid ARIA', async ({ page }) => {
  await signIn(page);
  await page.getByRole('combobox', { name: /^Select model/ }).click();
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
  expect(await violations(page, '[role="dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');

  await page.goto('/settings/attachments');
  await page.getByRole('button', { name: /^Filter attachments/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'All Files' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(await violations(page, '[role="menu"]')).toEqual([]);
  await page.keyboard.press('Escape');

  await page.goto('/admin/storage');
  await page.getByRole('combobox', { name: 'Driver' }).click();
  await expect(page.getByRole('listbox', { name: 'Driver' })).toBeVisible();
  expect(await violations(page, '[role="listbox"]')).toEqual([]);
});
