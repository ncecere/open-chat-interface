import { expect, type Page, test } from '@playwright/test';

/**
 * The settings layout at desktop and phone widths: the page never overflows
 * sideways, and the sections are tabs on one row or one menu, never wrapped.
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

/** How far the page is wider than the window; 0 when nothing overflows. */
const sidewaysOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('settings fit the window and offer every section without wrapping', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/history');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  const menu = page.getByRole('combobox', { name: 'Settings section' });
  if (await tabs.isVisible()) {
    // One row: every tab shares the first tab's top edge.
    const tops = await tabs
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().top)));
    expect(tops).toHaveLength(7);
    expect(new Set(tops).size).toBe(1);
    await expect(tabs.getByRole('link', { name: 'History & Sync' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tabs.getByRole('link', { name: 'Account' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.getByRole('link', { name: 'Memory' }).click();
  } else {
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('History & Sync');
    await menu.click();
    await page.getByRole('option', { name: 'Memory' }).click();
  }
  await expect(page).toHaveURL(/\/settings\/memory$/);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

  // Shortcuts and help are cards on every settings page.
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Need help?' })).toBeVisible();

  // The retired tabs' addresses land on Settings.
  await page.goto('/settings/shortcuts');
  await expect(page).toHaveURL(/\/settings$/);
});
