import { expect, test } from '@playwright/test';
import { signIn, storeThemeForProject } from './accessibility.helpers';

storeThemeForProject();

/**
 * Criteria automation cannot judge. Each of these encodes a defect found by a
 * manual keyboard pass, so a regression is caught rather than rediscovered.
 */
test.describe('WCAG 2.2 AA: keyboard operation', () => {
  test('a skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await signIn(page);

    // 2.4.1 Bypass Blocks: the sidebar otherwise puts ~124 thread links ahead
    // of the composer in tab order.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('Settings has a skip link first and one main landmark (#173)', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/account');
    await expect(page.getByRole('main')).toHaveCount(1);

    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  test('controls reached by keyboard show a focus indicator', async ({ page }) => {
    await signIn(page);

    // 2.4.7 Focus Visible and 1.4.11 Non-text Contrast. The indicator comes
    // from :focus-visible, which only engages for real keyboard navigation, so
    // this walks the tab order rather than calling focus() directly.
    const offenders: string[] = [];

    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab');

      const result = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;

        const style = getComputedStyle(element);
        const outlined = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        // A control may delegate its indicator to a focus-within container.
        const container = element.closest<HTMLElement>('[class*="focus-within:outline"]');
        const delegated = container ? getComputedStyle(container).outlineStyle !== 'none' : false;

        return {
          ok: outlined || delegated,
          label: element.getAttribute('aria-label') ?? element.tagName,
        };
      });

      if (result && !result.ok) offenders.push(result.label);
    }

    expect(offenders, `controls without a focus indicator: ${offenders}`).toEqual([]);
  });

  test('a dialog traps focus and restores it on dismiss', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/quotas');

    const trigger = page.getByRole('button', { name: 'New budget' });
    await trigger.focus();
    await trigger.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // 2.4.3 Focus Order: focus enters the dialog, then returns to its trigger.
    await expect(dialog.locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
