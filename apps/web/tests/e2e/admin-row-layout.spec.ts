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

for (const width of [768, 1024]) {
  test(`the Users table keeps Limits in view at ${width} px (#319)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/admin/users?*', (route) =>
      route.fulfill({
        json: {
          users: [
            account(1, 'walk7-resilience-invitee2@example.edu'),
            account(2, 'o.fitzgerald@northbrook.edu'),
          ],
          total: 2,
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
    const { scrollWidth, clientWidth } = await table.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
}
