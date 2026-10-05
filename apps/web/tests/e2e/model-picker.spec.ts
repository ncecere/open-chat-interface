import { expect, type Page, test } from '@playwright/test';

/**
 * Clears the new-user introduction when it appears.
 *
 * A fresh account is greeted by the wizard, so a signed-in test would
 * otherwise stall waiting for a composer that is not on screen yet.
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

async function signIn(page: import('@playwright/test').Page) {
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

test('model picker keeps its size while filtering and is keyboard reachable', async ({ page }) => {
  // The picker contract should not depend on an administrator having configured
  // paid providers in the CI database. Keep this UI test deterministic.
  await page.route('**/api/models', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          {
            id: 'model-openai',
            slug: 'test-reasoner',
            displayName: 'Test Reasoner',
            description: 'Strong at planning',
            providerId: 'provider-test',
            providerKind: 'openai-compatible',
            providerLabel: 'Test Gateway',
            upstreamModelId: 'test-reasoner',
            capabilities: ['reasoning', 'tool_calling'],
            labId: 'openai',
            contextWindow: 128000,
            maxOutputTokens: 8192,
            supportedEfforts: ['instant', 'high'],
            isDefault: true,
            sortOrder: 0,
          },
          {
            id: 'model-nvidia',
            slug: 'test-vision',
            displayName: 'Test Vision',
            description: 'Understands images',
            providerId: 'provider-test',
            providerKind: 'openai-compatible',
            providerLabel: 'Test Gateway',
            upstreamModelId: 'test-vision',
            capabilities: ['vision'],
            labId: 'nvidia',
            contextWindow: 32000,
            maxOutputTokens: 4096,
            supportedEfforts: [],
            isDefault: false,
            sortOrder: 1,
          },
        ],
      }),
    }),
  );
  await signIn(page);

  const trigger = page.getByRole('combobox', { name: /Select model/ });
  await trigger.click();

  const popup = page.getByLabel('Choose a model');
  const search = page.getByRole('combobox', { name: 'Search models' });
  await expect(popup).toBeVisible();
  await expect(search).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Filter models' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'All labs' })).toBeFocused();

  const firstLab = popup.locator('fieldset button:not([aria-label="All labs"])').first();
  test.skip((await firstLab.count()) === 0, 'At least two configured model labs are required');

  const before = await popup.boundingBox();
  await firstLab.click();
  const after = await popup.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
});
