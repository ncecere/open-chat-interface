import { expect, test } from '@playwright/test';
import { describeViolations, scan, signIn, storeThemeForProject } from './accessibility.helpers';

/**
 * WCAG 2.2 AA scans: sign-in, share, introduction, chat home and settings
 * pages. What automation can and cannot judge: accessibility.helpers.ts.
 */

storeThemeForProject();

test.describe('WCAG 2.2 AA: anonymous surfaces', () => {
  test('sign-in page has no violations', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('unavailable share page has no violations', async ({ page }) => {
    await page.goto('/share/not-a-real-share');
    await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
});

test.describe('WCAG 2.2 AA: authenticated surfaces', () => {
  test('new-user introduction has no violations', async ({ page }) => {
    // Scanned before it is dismissed, since for a new account this is the
    // first screen they meet.
    const email = process.env.E2E_ADMIN_EMAIL;
    const password = process.env.E2E_ADMIN_PASSWORD;
    test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

    // Deterministic per-page introduction data, with a delayed gate response
    // to exercise asynchronous loading without changing persisted preferences.
    await page.route('**/api/me/onboarding', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const onboarding = await response.json();
      expect(onboarding.pendingPolicy).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ response, json: { ...onboarding, needsIntroduction: true } });
    });

    await page.goto('/auth/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const skip = page.getByRole('button', { name: 'Skip for now' });
    // Authentication and the onboarding query finish after the submit click.
    // Missing fixture UI must fail, not silently erase accessibility coverage.
    await expect(skip).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('chat home has no violations', async ({ page }) => {
    await signIn(page);

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('settings has no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('settings customization, history, models, sharing and attachments have no violations', async ({
    page,
  }) => {
    await signIn(page);
    for (const [path, heading] of [
      ['/settings/customization', 'Customize your assistant'],
      ['/settings/history', 'History'],
      ['/settings/models', 'Models'],
      ['/settings/sharing', 'Sharing'],
      ['/settings/attachments', 'Attachments'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      const results = await scan(page);
      expect(describeViolations(results), `${path}\n${describeViolations(results)}`).toBe('');
    }
  });

  test('settings connectors has no violations', async ({ page }) => {
    await page.route('**/api/connectors', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          connectors: [
            {
              id: 'c1',
              name: 'Docs',
              slug: 'docs',
              connected: true,
              needsReconnect: false,
              toolCount: 2,
            },
            {
              id: 'c2',
              name: 'CRM',
              slug: 'crm',
              connected: false,
              needsReconnect: true,
              toolCount: 1,
            },
            {
              id: 'c3',
              name: 'Wiki',
              slug: 'wiki',
              connected: false,
              needsReconnect: false,
              toolCount: 3,
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/settings/connectors');
    await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Wiki', exact: true })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
});
