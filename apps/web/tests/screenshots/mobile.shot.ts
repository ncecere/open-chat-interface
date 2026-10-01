import { expect, test } from '@playwright/test';
import { capture, signIn } from './helpers';

/**
 * The narrow layout, which differs enough to be worth documenting: the
 * sidebar becomes a dialog, the composer's controls collapse behind a single
 * button, and administration navigation moves into a drawer.
 */
test.describe('narrow screens', () => {
  test.skip(({ isMobile }) => !isMobile, 'Runs only in the mobile project');

  test('captures the chat home', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await capture(page, 'mobile-chat-home');
  });

  test('captures the sidebar', async ({ page }) => {
    await signIn(page);
    await page.goto('/');

    const toggle = page.getByRole('button', { name: 'Open sidebar', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('dialog', { name: 'Conversation sidebar' })).toBeVisible();
    await capture(page, 'mobile-sidebar');
  });

  test('captures administration', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await capture(page, 'mobile-admin-overview');
  });

  test('captures the administration navigation drawer', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Open admin navigation', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Administration' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Users', exact: true })).toBeVisible();
    await capture(page, 'mobile-admin-navigation');
  });

  test('captures the sign-in page', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await capture(page, 'mobile-sign-in');
  });
});
