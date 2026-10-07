import { expect, type Page, test } from '@playwright/test';

/**
 * Admin rows measured in a real browser: layout a unit test cannot see.
 * The acceptable-use list is served from a fixture so the spec needs no
 * draft on the instance and changes nothing there.
 */
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

const version = (overrides: Record<string, unknown>) => ({
  id: 'policy-draft',
  version: 2,
  title: 'Walk AUP draft',
  body: 'Be kind.',
  publishedAt: null,
  acceptanceCount: 0,
  createdAt: '2026-10-05T12:00:00.000Z',
  ...overrides,
});

test('an acceptable-use version keeps its title and actions inside the card at 390 px (#168)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/admin/policies', (route) =>
    route.fulfill({
      json: {
        policies: [
          version({}),
          version({
            id: 'policy-live',
            version: 1,
            title: 'Acceptable use',
            publishedAt: '2026-10-01T12:00:00.000Z',
            acceptanceCount: 12,
          }),
        ],
      },
    }),
  );
  await signIn(page);
  await page.goto('/admin/policies');
  const title = page.getByText('Walk AUP draft', { exact: true });
  // Attached, not visible: the bug collapsed the title to 0 px wide.
  await expect(title).toBeAttached();

  const card = title.locator('xpath=ancestor::div[contains(@class, "px-4")][1]');
  const cardBox = (await card.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  // The title has room to be read, and the meta line is not squeezed into a sliver.
  expect(titleBox.width).toBeGreaterThan(80);
  const meta = card.getByText(/Not published/);
  expect((await meta.boundingBox())!.width).toBeGreaterThan(150);
  // Every action, Publish included, stays inside the card and the viewport.
  for (const button of await card.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});

test('the Users table keeps each Joined date on one line at 1440 px (#170)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto('/admin/users');
  const table = page.getByRole('region', { name: 'Accounts' }).locator('table');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const joined = await table.evaluate((element) => {
    const headers = [...element.querySelectorAll('thead th')];
    const column = headers.findIndex((header) => header.textContent?.includes('Joined'));
    return [...element.querySelectorAll('tbody tr')].map((row) => {
      const cell = row.children[column] as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(cell);
      // One line of text has one distinct top across its boxes.
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      return { text: cell.textContent, lines: tops.size };
    });
  });
  expect(joined.filter((cell) => cell.lines > 1)).toEqual([]);
});

const account = (index: number, email: string) => ({
  id: `layout-user-${index}`,
  email,
  name: `Layout Person ${index}`,
  image: null,
  role: 'user',
  emailVerified: true,
  banned: false,
  banReason: null,
  lastSeenAt: null,
  threadCount: 1234,
  messageCount: 0,
  createdAt: '2026-04-20T12:00:00.000Z',
  legalHold: false,
});

// Every width the admin shell supports from a tablet up. Below 768 the table
// scrolls sideways inside its own region by design.
for (const width of [768, 900, 1024, 1100, 1280, 1440]) {
  test(`the Users table keeps Limits in view and its addresses readable at ${width} px (#319, #334)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/admin/users?*', (route) =>
      route.fulfill({
        json: {
          users: [
            account(1, 'walk7-resilience-invitee2@example.edu'),
            account(2, 'o.fitzgerald@northbrook.edu'),
            account(3, 'walk8-target@example.com'),
          ],
          total: 3,
        },
      }),
    );
    await signIn(page);
    await page.goto('/admin/users');
    const table = page.getByRole('region', { name: 'Accounts' });
    await expect(table.getByRole('button', { name: /^Limits for / }).first()).toBeVisible();
    // Since "Threads" became "Conversations" (#305) the table needed 750 px
    // and cut Limits off in a 718 or 686 px area, with nothing showing that
    // it scrolled sideways.
    const measured = await table.evaluate((element) => {
      const headers = [...element.querySelectorAll('thead th')];
      const user = headers.findIndex((header) => header.textContent?.includes('User'));
      // Where each address wraps: the character that opens each line after
      // the first. A word is never cut mid-way when it can break at "@" or ".".
      const lineStarts = [...element.querySelectorAll('tbody tr td p')].map((paragraph) => {
        const starts: string[] = [];
        let top: number | null = null;
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent ?? '';
          for (let index = 0; index < value.length; index++) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getClientRects()[0];
            if (!rect) continue;
            if (top !== null && Math.abs(rect.top - top) > 4) starts.push(value[index]!);
            top = rect.top;
          }
        }
        return { text: paragraph.textContent ?? '', starts };
      });
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        userWidth: headers[user]!.getBoundingClientRect().width,
        lineStarts,
      };
    });
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth);
    // The address column was squeezed to about 100 px (#334).
    expect(measured.userWidth).toBeGreaterThanOrEqual(150);
    for (const { text, starts } of measured.lineStarts) {
      expect(
        starts.filter((start) => start !== '@' && start !== '.'),
        text,
      ).toEqual([]);
    }
  });
}

// The hint is the only on-screen word on what the box searches, and it was
// cut to "Search actor, ac" between 768 and about 1100 px, where the box shared
// its row with two filters and Export (#335).
for (const width of [390, 768, 1024, 1100, 1280, 1440]) {
  test(`the Audit log search box shows its whole hint at ${width} px (#335)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.goto('/admin/audit');
    const search = page.getByRole('searchbox', { name: 'Search audit events' });
    await expect(search).toBeVisible();
    const { needed, available } = await search.evaluate((element) => {
      const input = element as HTMLInputElement;
      const style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = style.font;
      const sides = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const;
      return {
        needed: context.measureText(input.placeholder).width,
        available:
          input.getBoundingClientRect().width -
          sides.reduce((sum, side) => sum + Number.parseFloat(style[side]), 0),
      };
    });
    expect(needed).toBeLessThanOrEqual(available);
  });
}
