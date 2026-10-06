import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Replies in a person's own conversation, measured in a real browser: wrapping,
 * line breaks, headings and accessible names come from CSS and the rendered
 * DOM. The conversation is served from a fixture, so the spec changes nothing
 * on the instance; it only signs in.
 */
const created = '2026-10-05T12:00:00.000Z';

let storageState: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['storageState']>>;

test.beforeAll(async ({ browser }) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  storageState = await context.storageState();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(storageState.cookies);
});

/** Opens a conversation whose one reply has these parts. */
async function openReply(page: Page, id: string, parts: unknown[], question = 'A question') {
  await page.route(`**/api/chat/${id}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id, temporary: false, expiresAt: null },
        messages: [
          {
            id: `${id}-question`,
            role: 'user',
            parts: [{ type: 'text', text: question }],
            metadata: { status: 'complete', createdAt: created },
          },
          {
            id: `${id}-reply`,
            role: 'assistant',
            parts,
            metadata: { status: 'complete', createdAt: created },
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/artifacts?threadId=${id}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ artifacts: [] }) }),
  );
  await page.goto(`/chat/${id}`);
  const reply = page.locator(`[data-message-id="${id}-reply"]`);
  await expect(reply).toBeVisible();
  return reply;
}

const TOKEN = 'ABCDEFGHIJ'.repeat(9);

for (const width of [390, 1440]) {
  test(`a long unbroken word wraps inside the reply at ${width} px (#187)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reply = await openReply(page, 'fix3-wrap', [
      { type: 'text', text: `The key is ${TOKEN} and it never breaks.` },
    ]);
    const paragraph = reply.locator('p', { hasText: 'The key is' });
    await expect(paragraph).toBeVisible();
    const scroller = await reply.evaluate((element) => {
      let node: HTMLElement | null = element.parentElement;
      while (node && getComputedStyle(node).overflowY !== 'auto') node = node.parentElement;
      return node ? { scroll: node.scrollWidth, client: node.clientWidth } : null;
    });
    // The conversation cannot be panned sideways.
    expect(scroller).not.toBeNull();
    expect(scroller!.scroll).toBeLessThanOrEqual(scroller!.client);
    const column = (await reply.boundingBox())!;
    const right = await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
    });
    expect(right).toBeLessThanOrEqual(column.x + column.width + 0.5);
  });
}

test("a reply's headings sit below the page's one h1 (#212)", async ({ page }) => {
  const reply = await openReply(page, 'fix3-headings', [
    { type: 'text', text: '# Ten Facts About Owls\n\nOwls are birds.\n\n## Hunting\n\nAt night.' },
  ]);
  await expect(reply.getByRole('heading', { name: 'Ten Facts About Owls' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    reply.getByRole('heading', { level: 2, name: 'Ten Facts About Owls' }),
  ).toBeVisible();
  await expect(reply.getByRole('heading', { level: 3, name: 'Hunting' })).toBeVisible();
});
