import { expect, type Locator, type Page } from '@playwright/test';

/**
 * After signing in, a new account sees the introduction before the app, and an
 * account that has seen it goes straight to the app. Which one is not known
 * until the page has loaded, and how long that takes depends on the machine:
 * signing in hashes a password, and the first requests to a freshly started
 * server are slow, with several workers doing it at once. So this waits for
 * whichever appears (up to 30 seconds), not a fixed few seconds for one of
 * them, skips the introduction if it is the one that came, and then expects the
 * app's own element.
 */
export async function reachApp(page: Page, appElement: Locator): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await expect(skip.or(appElement).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(appElement).toBeVisible();
}
