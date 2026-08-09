import { expect, test } from '@playwright/test';
import { capture, signIn } from './helpers';

test.describe('the chat interface', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('captures the home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await capture(page, 'user-chat-home');
  });

  test('captures the model picker', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: /select model/i }).click();
    await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
    await capture(page, 'user-model-picker');
  });

  test('captures a model information card', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: /select model/i }).click();

    const details = page.getByRole('button', { name: /^Details for/ }).first();
    await expect(details).toBeVisible();
    await details.click();
    await capture(page, 'user-model-details');
  });

  test('captures a conversation', async ({ page }) => {
    await page.goto('/');

    // Any seeded thread: the point is the reading layout, not the words.
    // Asserted rather than guarded, so a selector that stops matching fails
    // the run instead of quietly producing no image.
    const thread = page.locator('a[href^="/chat/"]').first();
    await expect(thread).toBeVisible();
    await thread.click();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await capture(page, 'user-conversation');
  });

  const SETTINGS: { route: string; name: string }[] = [
    { route: '/settings', name: 'user-settings-account' },
    { route: '/settings/customization', name: 'user-settings-customization' },
    { route: '/settings/models', name: 'user-settings-models' },
    { route: '/settings/history', name: 'user-settings-history' },
    { route: '/settings/attachments', name: 'user-settings-attachments' },
  ];

  for (const entry of SETTINGS) {
    test(`captures ${entry.name}`, async ({ page }) => {
      await page.goto(entry.route);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await capture(page, entry.name);
    });
  }
});

test.describe('signed out', () => {
  test('captures the sign-in page', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await capture(page, 'user-sign-in');
  });
});
