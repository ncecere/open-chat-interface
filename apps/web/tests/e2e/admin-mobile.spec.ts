import { expect, type Page, test } from '@playwright/test';
import { ADMIN_OVERVIEW, NAV_SECTIONS } from '../../src/lib/admin-navigation';

const PHONE = { width: 390, height: 844 };

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

/**
 * Every admin page fits a phone screen: wide tables scroll inside their own
 * container rather than widening the page. Absolutely positioned descendants
 * (such as a select's hidden native control) once escaped a scroll container
 * and pushed the whole Users page sideways.
 */
test('admin pages do not scroll sideways on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);

  const routes = [ADMIN_OVERVIEW, ...NAV_SECTIONS.flatMap((section) => section.items)].map(
    (item) => item.to,
  );
  const overflowing: string[] = [];
  const wrapped: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // Let lazily loaded lists render before measuring.
    await page.waitForLoadState('networkidle');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width > PHONE.width) overflowing.push(`${route} (${width}px)`);
    // A tab strip is one row: it scrolls sideways rather than wrapping a tab
    // onto a second line inside the same pill (#89).
    const rows = await page
      .getByRole('tablist')
      .evaluateAll((lists) =>
        lists.map(
          (list) =>
            new Set(
              [...list.querySelectorAll('[role="tab"]')].map((tab) =>
                Math.round(tab.getBoundingClientRect().top),
              ),
            ).size,
        ),
      );
    if (rows.some((count) => count > 1)) wrapped.push(route);
  }
  expect(overflowing, `Pages wider than ${PHONE.width}px`).toEqual([]);
  expect(wrapped, 'Pages with a tab strip on more than one row').toEqual([]);
});
