import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

const IMAGE_DIR = path.resolve(import.meta.dirname, '../../../../docs/images');

/**
 * Signs in as the administrator the demonstration instance was seeded with.
 *
 * Credentials come from the environment rather than being written here, so a
 * capture run cannot become a place where a working password lives in the
 * repository.
 */
export async function signIn(page: Page): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to capture screenshots');
  }

  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The introduction greets an account that has not completed it, and would
  // otherwise appear in every subsequent capture.
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

/**
 * Photographs the current page into `docs/images`.
 *
 * Waits for animations and fonts before shooting. Without the font wait the
 * first capture of a run lands mid-swap and renders in a fallback face, which
 * is subtle enough to survive review and wrong in every image.
 */
export async function capture(page: Page, name: string): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true });

  await page.waitForFunction(() => document.fonts.status === 'loaded').catch(() => undefined);
  await page
    .waitForFunction(
      () => document.getAnimations().every((animation) => animation.playState !== 'running'),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);

  await page.screenshot({ path: path.join(IMAGE_DIR, `${name}.png`) });
}

/** Opens an administrative page and waits for its heading to settle. */
export async function gotoAdmin(page: Page, route: string, heading: string): Promise<void> {
  await page.goto(route);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}
