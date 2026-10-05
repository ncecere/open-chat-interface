import { expect, type Page, type Request, test } from '@playwright/test';

/**
 * File output (v0.9): "Export as…" on a reply downloads the file the API
 * generates, under the name it gives, and shows a refusal inline. Self-
 * contained: the conversation and the export responses are routed.
 */
const THREAD_ID = 'file-export-thread';
const REPLY_ID = 'file-export-answer';
const FILENAME = 'quarterly-numbers-reply-2026-10-02.docx';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const REPLY = [
  '## Quarterly numbers',
  '',
  '| Region | Sales |',
  '| --- | ---: |',
  '| North | 12 |',
  '| South | 9 |',
].join('\n');

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

async function routeConversation(page: Page) {
  await page.route(`**/api/chat/${THREAD_ID}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [
          {
            id: 'file-export-question',
            role: 'user',
            parts: [{ type: 'text', text: 'Summarise the quarter' }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
          },
          {
            id: REPLY_ID,
            role: 'assistant',
            parts: [{ type: 'text', text: REPLY }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:01.000Z' },
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/artifacts?threadId=${THREAD_ID}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ artifacts: [] }) }),
  );
}

const exportRequest = (url: URL) =>
  url.pathname === `/api/threads/${THREAD_ID}/messages/${REPLY_ID}/export`;

async function openExportMenu(page: Page) {
  const reply = page.getByRole('article', { name: 'Assistant message' });
  await expect(reply.getByRole('table')).toBeVisible({ timeout: 15_000 });
  const trigger = reply.getByRole('button', { name: 'Export as…' });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return { trigger, menu };
}

test('a reply downloads as a Word document named by the API', async ({ page }) => {
  await signIn(page);
  await routeConversation(page);
  const requests: Request[] = [];
  await page.route(exportRequest, (route) => {
    requests.push(route.request());
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': DOCX,
        'content-disposition': `attachment; filename="${FILENAME}"`,
        'cache-control': 'no-store',
      },
      body: Buffer.from('PK\u0003\u0004 test document'),
    });
  });

  await page.goto(`/chat/${THREAD_ID}`);
  const { trigger, menu } = await openExportMenu(page);
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  // The reply has a table, so a spreadsheet is offered too.
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Word document (.docx)',
    'PDF (.pdf)',
    'Presentation (.pptx)',
    'Spreadsheet (.xlsx)',
  ]);

  const downloading = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Word document (.docx)' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(FILENAME);
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0]!.url());
  expect(url.pathname).toBe(`/api/threads/${THREAD_ID}/messages/${REPLY_ID}/export`);
  expect(url.searchParams.get('format')).toBe('docx');
  expect(requests[0]!.method()).toBe('GET');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a refused export explains itself next to the reply', async ({ page }) => {
  await signIn(page);
  await routeConversation(page);
  await page.route(exportRequest, (route) =>
    route.fulfill({
      status: 429,
      headers: { 'retry-after': '60' },
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many downloads in the last hour. Try again later.',
        },
      }),
    }),
  );

  await page.goto(`/chat/${THREAD_ID}`);
  const { trigger, menu } = await openExportMenu(page);
  // Keyboard only: the last option, chosen with Enter; focus returns to the button.
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Spreadsheet (.xlsx)' })).toBeFocused();
  await page.keyboard.press('Enter');
  const reply = page.getByRole('article', { name: 'Assistant message' });
  await expect(reply.getByRole('alert')).toContainText(
    'Too many downloads in the last hour. Try again later.',
  );
  await expect(trigger).toBeFocused();
  await reply.getByRole('button', { name: 'Dismiss' }).click();
  await expect(reply.getByRole('alert')).toHaveCount(0);
});
