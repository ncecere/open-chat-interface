import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * WCAG 2.2 Level AA conformance scan.
 *
 * Automation covers roughly a third of the success criteria: contrast, names,
 * roles, and structure. Focus order, meaningful sequence, and whether an error
 * message actually helps still need a human pass, so a green run here is a
 * regression net rather than a conformance claim.
 */
const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
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
function describeViolations(results: Awaited<ReturnType<typeof scan>>): string {
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

async function signIn(page: Page) {
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

  test('admin dashboard has no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin general settings have no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings/general');
    await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin roles and access has no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { name: 'Roles & access', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Messages per minute')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin connectors has no violations', async ({ page }) => {
    // A routed connector with a read and a write tool, so the tool controls are scanned too.
    const connectorTool = (id: string, name: string, kind: string, enabled: boolean) => ({
      id,
      toolId: `mcp__docs__${name}`,
      name,
      title: null,
      description: `The ${name} tool.`,
      kind,
      serverKind: kind,
      enabled,
      missing: false,
      lastSeenAt: '2026-10-01T10:00:00.000Z',
    });
    await page.route('**/api/admin/connectors', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          connectors: [
            {
              id: 'c1',
              name: 'Docs',
              slug: 'docs',
              url: 'https://mcp.example.test/mcp',
              authMode: 'shared',
              sharedHeaderName: 'Authorization',
              hasSharedCredential: true,
              oauthClientId: null,
              hasOauthClientSecret: false,
              oauthClientSource: null,
              oauthScopes: '',
              enabled: true,
              allowPrivateNetwork: false,
              accountCount: 0,
              lastContactAt: '2026-10-01T10:00:00.000Z',
              lastErrorAt: '2026-10-01T11:00:00.000Z',
              lastError: 'Docs did not respond in time.',
              oauthRedirectUrl: 'https://oci.example.test/api/connectors/oauth/callback',
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
              tools: [
                connectorTool('t1', 'search', 'read', true),
                connectorTool('t2', 'create_page', 'write', false),
              ],
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/admin/connectors');
    await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'search' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
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

  test('a project page has no violations', async ({ page }) => {
    await signIn(page);
    // Created through the real API with the signed-in session's cookies.
    const created = await page.request.post('/api/projects', {
      data: { name: `Accessibility project ${Date.now()}`, instructions: 'Answer clearly.' },
    });
    expect(created.status()).toBe(201);
    const { project } = (await created.json()) as { project: { id: string; name: string } };

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: project.name })).toBeVisible();
    await expect(page.getByText('No conversations yet.')).toBeVisible();

    // Every tab, reached with the keyboard as the tabs pattern prescribes.
    for (const [name, ready] of [
      ['Conversations', 'No conversations yet.'],
      ['Instructions', 'Answer clearly.'],
      ['Files', 'No files yet.'],
      ['Settings', 'Delete project'],
    ] as const) {
      if (name !== 'Conversations') await page.keyboard.press('ArrowRight');
      else await page.getByRole('tab', { name }).focus();
      await expect(page.getByRole('tab', { name, selected: true })).toBeFocused();
      if (name === 'Instructions')
        await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(ready);
      else await expect(page.getByText(ready).first()).toBeVisible();
      const results = await scan(page);
      expect(describeViolations(results), `${name}: ${describeViolations(results)}`).toBe('');
    }
  });

  test('the move to project dialog has no violations while open', async ({ page }) => {
    await signIn(page);
    const created = await page.request.post('/api/threads', { data: { title: 'To be moved' } });
    expect(created.status()).toBe(201);
    const { thread } = (await created.json()) as { thread: { id: string } };

    await page.goto(`/chat/${thread.id}`);
    await page.getByRole('button', { name: 'Move to project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move to project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'No project' })).toBeChecked();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('the reply switcher on a retried turn has no violations', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    const reply = (id: string, text: string) => ({
      id,
      role: 'assistant',
      parts: [{ type: 'text', text }],
      metadata: { status: 'complete', createdAt: created },
    });
    const replies = [reply('a11y-reply-1', 'First answer'), reply('a11y-reply-2', 'Second answer')];
    await page.route('**/api/chat/a11y-replies/messages', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-replies', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'A question' }],
              metadata: { status: 'complete', createdAt: created },
            },
            replies[1],
          ],
          replies,
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-replies');
    const group = page.getByRole('group', { name: 'Replies' });
    await expect(group.getByRole('status')).toHaveText('Reply 2 of 2');
    await group.getByRole('button', { name: 'Previous reply' }).focus();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('a tool step and an approval card have no violations', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    await page.route('**/api/chat/a11y-tools/messages', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-tools', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-tools-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'Look it up and send a note' }],
              metadata: { status: 'complete', createdAt: created },
            },
            {
              id: 'a11y-tools-reply',
              role: 'assistant',
              parts: [
                { type: 'step-start' },
                {
                  type: 'tool-web_search',
                  toolCallId: 'a11y-search',
                  state: 'output-available',
                  input: { query: 'opening hours' },
                  output: { query: 'opening hours', results: [] },
                },
                { type: 'step-start' },
                {
                  type: 'tool-send_note',
                  toolCallId: 'a11y-note',
                  title: 'Send note',
                  state: 'approval-requested',
                  input: { to: 'Ada' },
                  approval: { id: 'a11y-approval' },
                },
              ],
              metadata: { status: 'complete', createdAt: created },
            },
          ],
          replies: [],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-tools');
    const card = page.getByRole('region', { name: 'Allow Send note?' });
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page
      .getByRole('button', { name: "Searched the web for 'opening hours' · 0 results" })
      .click();
    await card.getByRole('button', { name: 'Deny' }).focus();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('a dialog has no violations while open', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/quotas');
    await page.getByRole('button', { name: 'New policy' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
});

/**
 * Criteria automation cannot judge. Each of these encodes a defect found by a
 * manual keyboard pass, so a regression is caught rather than rediscovered.
 */
test.describe('WCAG 2.2 AA: keyboard operation', () => {
  test('a skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await signIn(page);

    // 2.4.1 Bypass Blocks: the sidebar otherwise puts ~124 thread links ahead
    // of the composer in tab order.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
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

    const trigger = page.getByRole('button', { name: 'New policy' });
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
});
