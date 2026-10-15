import { expect, test } from '@playwright/test';
import { signIn, storeThemeForProject } from './accessibility.helpers';
import { LABELLED, openLabelledConversation } from './classification.fixtures';

storeThemeForProject();

/**
 * Criteria automation cannot judge. Each of these encodes a defect found by a
 * manual keyboard pass, so a regression is caught rather than rediscovered.
 */
test.describe('WCAG 2.2 AA: keyboard operation', () => {
  test('a skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await signIn(page);
    // A conversation, opened directly: the home page puts the cursor in the
    // message box instead, so there is nothing to skip there (#251).
    const created = await page.request.post('/api/threads', { data: { title: 'Skip link' } });
    expect(created.ok()).toBe(true);
    const { thread } = (await created.json()) as { thread: { id: string } };
    await page.goto(`/chat/${thread.id}`);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

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
    // Account is /settings; /settings/account is the not-found page, whose own
    // <main> once let this pass without Settings ever loading.
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
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
  test('a model the data classes forbid is reached, announced and not chosen by keyboard (v0.14)', async ({
    page,
  }) => {
    await signIn(page);
    await openLabelledConversation(page);

    // Open the picker from the keyboard, as a person using only one would.
    const trigger = page.getByRole('combobox', { name: /Select model/ });
    await expect(trigger).toHaveAccessibleName(`Select model. Current model: ${LABELLED.approved}`);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const search = page.getByRole('combobox', { name: 'Search models' });
    await expect(search).toBeFocused();

    // Arrowing onto the forbidden model makes it the active descendant, and its
    // accessible name carries the reason, so a screen reader reads it out.
    await page.keyboard.press('ArrowDown');
    const plain = page.getByRole('option', { name: new RegExp(LABELLED.plain) });
    await expect(search).toHaveAttribute(
      'aria-activedescendant',
      (await plain.getAttribute('id'))!,
    );
    await expect(plain).toHaveAttribute('aria-disabled', 'true');
    await expect(plain).toHaveAccessibleName(
      new RegExp(`${LABELLED.plain}.*Not approved for ${LABELLED.className} and Payroll`),
    );

    // Enter does not choose it, and the picker stays open to choose another.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Models' })).toBeHidden();
    await expect(trigger).toHaveAccessibleName(`Select model. Current model: ${LABELLED.approved}`);
    await expect(trigger).toBeFocused();
  });

  test('the label chips are reachable and a person’s own label is removable by keyboard (v0.14)', async ({
    page,
  }) => {
    await signIn(page);
    await openLabelledConversation(page);

    const remove = page.getByRole('button', { name: 'Remove the Health data label' });
    await remove.focus();
    await expect(remove).toBeFocused();
    // Only the label the person added has one; the rest explain themselves in text.
    await expect(page.getByRole('button', { name: /^Remove the / })).toHaveCount(1);
    const outline = await remove.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    });
    expect(outline).toBe(true);

    // The Add label menu opens from the keyboard and closes back onto its button.
    const add = page.getByRole('button', { name: 'Add label' });
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Research data' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
  });
});
