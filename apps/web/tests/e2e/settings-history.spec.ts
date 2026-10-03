import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Settings → History (v0.9.1) in a real browser: more than 200 conversations
 * a page at a time, a title search sent to the server, and export/import at
 * the top. The conversation list is stubbed so the size of the history does
 * not depend on the fixture database.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TOTAL = 230;
const PAGE = 50;

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function thread(index: number) {
  const at = new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString();
  return {
    id: `stub-${index}`,
    title: index % 25 === 0 ? `Budget review ${index}` : `Conversation ${index}`,
    pinned: false,
    archived: false,
    temporary: false,
    expiresAt: null,
    parentThreadId: null,
    branchedFromMessageId: null,
    projectId: null,
    lastMessageAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

/** Serves GET /api/threads?view=history like the API: pages of 50 and a cursor. */
async function stubHistory(page: Page, requests: URLSearchParams[]) {
  const all = Array.from({ length: TOTAL }, (_, index) => thread(index));
  await page.route(/\/api\/threads\?.*view=history/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const search = params.get('search')?.toLowerCase() ?? '';
    const matching = all.filter((entry) => entry.title.toLowerCase().includes(search));
    const start = params.get('before') ? Number(params.get('before')) : 0;
    const threads = matching.slice(start, start + PAGE);
    const nextCursor = start + PAGE < matching.length ? String(start + PAGE) : null;
    await route.fulfill({ json: { threads, nextCursor } });
  });
}

test('pages past 200 conversations, searches titles, and links each one', async ({ page }) => {
  await signIn(page);
  const requests: URLSearchParams[] = [];
  await stubHistory(page, requests);
  await page.goto('/settings/history');

  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Conversations' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(PAGE);
  await expect(rows.first().getByRole('link', { name: 'Budget review 0' })).toHaveAttribute(
    'href',
    '/chat/stub-0',
  );

  for (const expected of [100, 150, 200, TOTAL]) {
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(rows).toHaveCount(expected);
  }
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  expect(requests.at(-1)?.get('before')).toBe('200');

  // Select all ticks every loaded row.
  await page.getByLabel('Select all').check();
  await expect(page.getByText(`${TOTAL} selected`)).toBeVisible();
  await page.getByLabel('Select all').uncheck();

  await page.getByLabel('Search conversation titles').fill('budget');
  await expect(rows).toHaveCount(10);
  expect(requests.at(-1)?.get('search')).toBe('budget');
  await expect(rows.first()).toContainText('Budget review 0');
});

test('puts export and import at the top, in accessible dialogs', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/history');
  await page.getByRole('button', { name: 'Export all conversations' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export all conversations' });
  await expect(exportDialog.getByRole('link', { name: 'Download export' })).toHaveAttribute(
    'href',
    '/api/me/export',
  );
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Import from ChatGPT or Claude' }).click();
  const importDialog = page.getByRole('dialog', { name: 'Import from ChatGPT or Claude' });
  await expect(importDialog.getByRole('button', { name: 'Choose export file' })).toBeVisible();
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  );
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
