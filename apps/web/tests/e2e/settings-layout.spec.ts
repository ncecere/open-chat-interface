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

/** The sections this person should see: Memory, Sharing and Connectors only when they have something. */
async function expectedSections(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/me');
  expect(response.ok()).toBe(true);
  const me = (await response.json()) as {
    features: { memory?: boolean; shareLinks?: boolean };
    settingsSummary: { memoryEntries: number; connectors: number; shareLinks: number };
  };
  return [
    'Account',
    'Customization',
    ...(me.features.memory !== false || me.settingsSummary.memoryEntries > 0 ? ['Memory'] : []),
    'History',
    'Models',
    ...(me.features.shareLinks !== false || me.settingsSummary.shareLinks > 0 ? ['Sharing'] : []),
    ...(me.settingsSummary.connectors > 0 ? ['Connectors'] : []),
    'Attachments',
  ];
}

test('settings fit the window and offer every section without wrapping', async ({ page }) => {
  await signIn(page);
  const sections = await expectedSections(page);
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
    expect(tops).toHaveLength(sections.length);
    expect(new Set(tops).size).toBe(1);
    await expect(tabs.getByRole('link')).toHaveText(sections);
    await expect(tabs.getByRole('link', { name: 'History', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tabs.getByRole('link', { name: 'Account' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.getByRole('link', { name: 'Models' }).click();
  } else {
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('History');
    await menu.click();
    await page.getByRole('option', { name: 'Models' }).click();
  }
  await expect(page).toHaveURL(/\/settings\/models$/);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

  // Help is a card on every settings page; shortcuts too, given a mouse (below).
  await expect(page.getByRole('heading', { name: 'Need help?' })).toBeVisible();

  // The retired tabs' addresses land on Settings.
  await page.goto('/settings/shortcuts');
  await expect(page).toHaveURL(/\/settings$/);

  // A hidden section's address still opens it.
  if (!sections.includes('Connectors')) {
    await page.goto('/settings/connectors');
    await expect(page.getByRole('heading', { level: 1, name: 'Connectors' })).toBeVisible();
  }
});

test('the header offers Light, Dark and System, and the wide avatar is 96px', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/customization');
  await expect(page.getByRole('button', { name: 'Toggle theme' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Appearance settings' }).click();
  await page.getByRole('menuitem', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
  // The Appearance row in Customization reflects the same choice.
  await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
  await page.locator('[role="radiogroup"] label', { hasText: 'Dark' }).click();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  const avatar = page.locator('.lg\\:size-24').first();
  const box = await avatar.boundingBox();
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  expect(box?.width).toBe(wide ? 96 : 48);
});

test('lists keyboard shortcuts only where there is a mouse or trackpad (#106)', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/settings');
  // The card beside it, shown everywhere: the side column has rendered.
  await expect(page.getByRole('heading', { name: 'Need help?' })).toBeVisible();
  const card = page.getByRole('heading', { name: 'Keyboard Shortcuts' });
  // mobile-chromium emulates a Pixel 7: a touch screen and no fine pointer.
  if (testInfo.project.use.hasTouch) await expect(card).toBeHidden();
  else await expect(card).toBeVisible();
});
