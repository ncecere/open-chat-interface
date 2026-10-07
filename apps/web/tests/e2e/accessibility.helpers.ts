import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Shared helpers for the accessibility-*.spec.ts files.
 *
 * WCAG 2.2 Level AA conformance scan.
 *
 * Automation covers roughly a third of the success criteria: contrast, names,
 * roles, and structure. Focus order, meaningful sequence, and whether an error
 * message actually helps still need a human pass, so a green run here is a
 * regression net rather than a conformance claim.
 */
export const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function scan(page: Page) {
  // The theme class is applied after mount, and `transition-colors` animates
  // the change. Scanning mid-transition samples blended colours that are on
  // screen for a fraction of a second and reports contrast failures against
  // values no user ever sees, so wait for animations to settle first.
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  );

  return new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
}

/** Reports each violation with the offending markup so failures are actionable. */
export function describeViolations(results: Awaited<ReturnType<typeof scan>>): string {
  return results.violations
    .map((violation) => {
      const nodes = violation.nodes.map((node) => `      ${node.html}`).join('\n');
      return `  [${violation.impact}] ${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join('\n');
}

/**
 * Clears the new-user introduction when it appears.
 *
 * A fresh account is greeted by the wizard, so every signed-in test would
 * otherwise stall waiting for a composer that is not on screen yet. Skipping
 * is the same choice a user has, so this exercises a real path.
 */
async function dismissIntroduction(page: Page) {
  const skip = page.getByRole('button', { name: 'Skip for now' });

  // The gate resolves after its own request, so an immediate visibility check
  // races it and reports "not present" while it is still loading. Wait for it
  // to settle either way before deciding.
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await expect(skip).toBeHidden();
  }
}

/**
 * The light-theme project (playwright.config.ts) scans every page in light:
 * the theme is the person's stored choice, not the colour scheme alone.
 * Call this at the top level of every accessibility spec.
 */
export function storeThemeForProject() {
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.project.name.endsWith('-light')) {
      await page.addInitScript(() => window.localStorage.setItem('oci.theme', 'light'));
    }
  });
}

export async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await dismissIntroduction(page);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}
