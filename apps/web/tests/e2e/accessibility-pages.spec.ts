import { expect, test } from '@playwright/test';
import { describeViolations, scan, signIn, storeThemeForProject } from './accessibility.helpers';
import { withGroup } from './fixtures/groups';
import { openSidebar, withSharingScene } from './fixtures/sharing';

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

  test('settings groups (for a manager) has no violations', async ({ page }) => {
    await signIn(page);
    await withGroup(page, async (group) => {
      await page.goto('/settings/groups');
      await expect(page.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: group.name, level: 2, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Members of this group' })).toBeVisible();

      const results = await scan(page);
      expect(describeViolations(results), describeViolations(results)).toBe('');
    });
  });
});

test.describe('WCAG 2.2 AA: project sharing (v0.14)', () => {
  test('the Share dialog, for a person and for a group, has no violations', async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await withSharingScene(browser, page, async ({ owned, editor }) => {
      await withGroup(page, async (group) => {
        await page.goto(`/projects/${owned.id}`);
        await page.getByRole('button', { name: 'Share', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: `Share “${owned.name}”` });
        await expect(dialog.getByRole('list', { name: 'Who has access' })).toContainText(
          editor.name,
        );
        let results = await scan(page);
        expect(describeViolations(results), describeViolations(results)).toBe('');

        // The group form, its picker open, and a refusal showing.
        await dialog.getByRole('radio', { name: 'A group' }).check();
        await dialog.getByRole('combobox', { name: 'Group' }).click();
        await expect(page.getByRole('option', { name: group.name })).toBeVisible();
        results = await scan(page);
        expect(describeViolations(results), describeViolations(results)).toBe('');
        await page.keyboard.press('Escape');
        await dialog.getByRole('radio', { name: 'A person' }).check();
        await dialog.getByLabel('Their email address').fill('not an address');
        await dialog.getByRole('button', { name: 'Share project' }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        results = await scan(page);
        expect(describeViolations(results), describeViolations(results)).toBe('');
      });
    });
  });

  test('Shared with me, on the Projects page and in the sidebar, has no violations', async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await withSharingScene(browser, page, async ({ shared, owner }) => {
      await page.goto('/projects');
      await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
      const section = page.getByRole('region', { name: 'Shared with me' });
      await expect(section).toContainText(shared.name);
      await expect(section).toContainText(owner.name);
      let results = await scan(page);
      expect(describeViolations(results), describeViolations(results)).toBe('');

      await openSidebar(page);
      await expect(page.getByRole('list', { name: 'Shared with me' }).first()).toContainText(
        shared.name,
      );
      results = await scan(page);
      expect(describeViolations(results), describeViolations(results)).toBe('');
    });
  });

  test("a viewer's project page, on every tab, has no violations", async ({ browser, page }) => {
    await signIn(page);
    await withSharingScene(browser, page, async ({ shared, owner }) => {
      await page.goto(`/projects/${shared.id}`);
      await expect(page.getByRole('heading', { name: shared.name, level: 1 })).toBeVisible();
      await expect(page.getByText(`Shared by ${owner.name} · Viewer`)).toBeVisible();
      for (const tab of ['Conversations', 'Instructions', 'Files', 'Settings']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
        if (tab === 'Files') await expect(page.getByText('Added by')).toBeVisible();
        if (tab === 'Settings')
          await expect(page.getByRole('button', { name: 'Leave project' })).toBeVisible();
        const results = await scan(page);
        expect(describeViolations(results), `${tab}: ${describeViolations(results)}`).toBe('');
      }
    });
  });

  test('the Transfer dialog and the Leave confirmation have no violations', async ({
    browser,
    page,
  }) => {
    await signIn(page);
    await withSharingScene(browser, page, async ({ owned, shared, editor }) => {
      await page.goto(`/projects/${owned.id}?tab=settings`);
      await page.getByRole('button', { name: 'Transfer project…' }).click();
      const dialog = page.getByRole('dialog', { name: `Transfer “${owned.name}”` });
      await dialog.getByRole('radio', { name: new RegExp(editor.name) }).check();
      await expect(dialog).toContainText(`${editor.name} becomes the owner`);
      let results = await scan(page);
      expect(describeViolations(results), describeViolations(results)).toBe('');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      await page.goto(`/projects/${shared.id}?tab=settings`);
      await page.getByRole('button', { name: 'Leave project' }).click();
      await expect(page.getByRole('dialog', { name: `Leave “${shared.name}”?` })).toBeVisible();
      results = await scan(page);
      expect(describeViolations(results), describeViolations(results)).toBe('');
    });
  });
});
