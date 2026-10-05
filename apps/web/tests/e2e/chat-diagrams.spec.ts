import { expect, type Page, test } from '@playwright/test';

const THREAD_ID = 'diagram-thread';

const DIAGRAM = [
  'Here is the flow:',
  '',
  '```mermaid',
  'flowchart LR',
  '  request[Request] --> gate{Allowed?}',
  '  gate -->|yes| model[Model]:::focus',
  '  gate -->|no| refuse[Refuse]',
  '```',
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

test('Mermaid diagrams render with the editorial theme', async ({ page }) => {
  await signIn(page);
  await page.route(`**/api/chat/${THREAD_ID}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [
          {
            id: 'question',
            role: 'user',
            parts: [{ type: 'text', text: 'Draw the request flow' }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
          },
          {
            id: 'answer',
            role: 'assistant',
            parts: [{ type: 'text', text: DIAGRAM }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:01.000Z' },
          },
        ],
      }),
    }),
  );

  await page.goto(`/chat/${THREAD_ID}`);
  const answer = page.locator('[data-message-id="answer"]');
  const diagram = answer.locator('svg[id^="mermaid"]');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  await expect(answer).not.toContainText('Mermaid plugin not available');
  await expect(diagram.getByText('Allowed?')).toBeVisible();

  // Flat and hairline: no drop shadows, 1px strokes.
  const node = diagram.locator('.node').first().locator('rect, polygon, path').first();
  expect(await node.evaluate((element) => getComputedStyle(element).strokeWidth)).toBe('1px');
  expect(await node.evaluate((element) => getComputedStyle(element).filter)).toBe('none');

  // The accent is reserved for the node marked :::focus.
  const focus = diagram.locator('.node.focus').locator('rect, polygon, path').first();
  const plain = diagram.locator('.node:not(.focus)').locator('rect, polygon, path').first();
  const stroke = (locator: typeof focus) =>
    locator.evaluate((element) => getComputedStyle(element).stroke);
  expect(await stroke(focus)).not.toBe(await stroke(plain));
});
