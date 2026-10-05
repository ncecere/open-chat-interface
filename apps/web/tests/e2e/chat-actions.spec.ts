import { expect, type Page, test } from '@playwright/test';

const sourceMessages = [
  {
    id: 'user-message',
    role: 'user',
    parts: [{ type: 'text', text: 'Original question' }],
    metadata: { status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
  },
  {
    id: 'assistant-message',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Original answer' }],
    metadata: {
      modelSlug: 'test-model',
      effort: 'high',
      status: 'complete',
      createdAt: '2026-01-01T00:00:01.000Z',
    },
  },
];

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
  await expect(page).toHaveURL(/\/$/);
  await dismissIntroduction(page);
}

test('sidebar exposes fork lineage and collapses pinned threads', async ({ page }) => {
  // By path: the sidebar asks for its view with `?view=sidebar` (v0.9.1).
  await page.route(
    (url) => url.pathname === '/api/threads',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          threads: [
            {
              id: 'pinned-thread',
              title: 'Pinned fixture',
              pinned: true,
              archived: false,
              temporary: false,
              expiresAt: null,
              parentThreadId: null,
              branchedFromMessageId: null,
              lastMessageAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'forked-thread',
              title: 'Forked fixture',
              pinned: false,
              archived: false,
              temporary: false,
              expiresAt: null,
              parentThreadId: 'parent-thread',
              branchedFromMessageId: 'source-message',
              lastMessageAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    },
  );
  await signIn(page);
  const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
  if (await openSidebar.isVisible()) await openSidebar.click();

  await expect(page.getByRole('link', { name: /^Go to parent thread of: / })).toHaveAttribute(
    'href',
    '/chat/parent-thread',
  );
  const pinned = page.getByRole('button', { name: 'Pinned' });
  await expect(pinned).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Pinned fixture' })).toBeVisible();
  await pinned.click();
  await expect(pinned).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Pinned fixture' })).toHaveCount(0);
});

test('assistant actions show attribution and create a true fork', async ({ page }) => {
  await signIn(page);

  await page.route('**/api/chat/source-thread/messages**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: 'source-thread', temporary: false, expiresAt: null },
        messages: sourceMessages,
      }),
    }),
  );
  await page.route('**/api/chat/child-thread/messages**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: 'child-thread', temporary: false, expiresAt: null },
        messages: sourceMessages,
      }),
    }),
  );

  let forkBody: unknown;
  await page.route('**/api/threads/source-thread/forks', async (route) => {
    forkBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        thread: {
          id: 'child-thread',
          title: 'Fork',
          pinned: false,
          archived: false,
          temporary: false,
          expiresAt: null,
          parentThreadId: 'source-thread',
          branchedFromMessageId: 'assistant-message',
          lastMessageAt: '2026-01-01T00:00:01.000Z',
          createdAt: '2026-01-01T00:00:02.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z',
        },
      }),
    });
  });

  await page.goto('/chat/source-thread');
  const assistant = page.getByRole('article', { name: 'Assistant message' });
  await assistant.hover();

  await expect(assistant.getByText('test-model')).toBeVisible();
  await expect(assistant.getByText('(high)')).toBeVisible();
  await expect
    .poll(() =>
      assistant
        .locator('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    )
    .toEqual(['Copy message', 'Export as…', 'Fork conversation here', 'Retry']);

  await Promise.all([
    page.waitForURL('**/chat/child-thread'),
    assistant.getByRole('button', { name: 'Fork conversation here' }).click(),
  ]);
  expect(forkBody).toEqual({ messageId: 'assistant-message' });
});
