import { expect, test } from '@playwright/test';

/**
 * The auth pages share one frame (#112): the wordmark sits at the same height
 * on every page (forgot-password sat about 50px higher), a reset link that is
 * invalid says so with a way back, and no field pretends to hold a password.
 */

test('auth pages line up, and a bad reset link offers a way back', async ({ page }) => {
  const tops: Record<string, number> = {};
  for (const path of ['/auth/login', '/auth/forgot-password', '/auth/reset-password?token=walk']) {
    await page.goto(path);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeAttached();
    // The frame's first box: the wordmark row above the form.
    const top = await page
      .locator('main, body > div')
      .first()
      .evaluate((root) => {
        const first =
          root.querySelector('img, svg, [class*="wordmark" i]') ?? root.firstElementChild;
        return Math.round(first?.getBoundingClientRect().top ?? -1);
      });
    tops[path] = top;
  }
  const values = Object.values(tops);
  expect(Math.max(...values) - Math.min(...values), JSON.stringify(tops)).toBeLessThanOrEqual(4);

  await page.goto('/auth/login');
  await expect(page.getByLabel('Password', { exact: true })).not.toHaveAttribute(
    'placeholder',
    /•/,
  );

  // The emailed link, with a token that is not valid, comes back with ?error=.
  await page.goto('/api/auth/reset-password/walk-bogus-token?callbackURL=%2Fauth%2Freset-password');
  await expect(page.getByText('This reset link is invalid or has expired.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to sign in' })).toBeVisible();

  // A token that fails when the new password is submitted says the same.
  await page.goto('/auth/reset-password?token=walk-bogus-token');
  await expect(page.getByRole('link', { name: 'Return to sign in' })).toBeVisible();
  await page.getByLabel('New password').fill('Walk-new-password-123');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('This reset link is invalid or has expired.')).toBeVisible();
});
