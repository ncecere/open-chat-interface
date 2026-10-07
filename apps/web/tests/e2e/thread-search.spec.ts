import { expect, type Page, test } from '@playwright/test';

/**
 * Conversation search: type a word, see the matching line, open it, and land
 * on that message rather than the end of the conversation.
 *
 * Self-contained so it runs on any seeded instance (CI has no model provider
 * to create conversations with): the search endpoint, the conversation's
 * history and the model catalog are routed. The server side of search is
 * covered by apps/api/src/__tests__/live/thread-search.live.test.ts.
 */

const THREAD_ID = 'search-thread';
const TARGET_ID = 'history-12';
const START = '\u0001';
const END = '\u0002';
const CREATED = '2026-01-01T00:00:00.000Z';

const MODEL = {
  id: 'model-search',
  slug: 'search-model',
  displayName: 'Search model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'search-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

const paragraph =
  'Conversation text that is long enough to wrap across several lines on a phone and on a desktop, so the transcript is many screens tall. ';

const MESSAGES = Array.from({ length: 60 }, (_, index) => ({
  id: `history-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  parts: [
    {
      type: 'text',
      text:
        index === 12
          ? `Message ${index}. The quokka lives on Rottnest Island. ${paragraph.repeat(2)}`
          : `Message ${index}. ${paragraph.repeat(3)}`,
    },
  ],
  metadata: { status: 'complete', createdAt: CREATED },
}));

const RESULT = {
  thread: {
    id: THREAD_ID,
    title: 'Search fixture conversation',
    pinned: false,
    archived: true,
    temporary: false,
    expiresAt: null,
    parentThreadId: null,
    branchedFromMessageId: null,
    lastMessageAt: CREATED,
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  rank: 0.6,
  titleHighlight: 'Search fixture conversation',
  matches: [
    {
      messageId: TARGET_ID,
      role: 'assistant',
      snippet: `Message 12. The ${START}quokka${END} lives on <b>Rottnest</b> Island.`,
    },
  ],
};

async function installApi(page: Page, queries: string[]) {
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.route(
    (url) => url.pathname === '/api/threads/search',
    (route) => {
      const query = new URL(route.request().url()).searchParams.get('q') ?? '';
      queries.push(query);
      const results = 'quokka'.startsWith(query.toLowerCase()) ? [RESULT] : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results }) });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/chat/${THREAD_ID}/messages`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: THREAD_ID, temporary: false, expiresAt: null },
          messages: MESSAGES,
        }),
      }),
  );
}

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

const scroller = (page: Page) => page.locator('[data-conversation-scroller]');
const target = (page: Page) => page.locator(`[data-message-id="${TARGET_ID}"]`);

/** How far the target's centre sits from the centre of the conversation view, as a fraction of its height. */
function offCentre(page: Page) {
  return scroller(page).evaluate((node, id) => {
    const row = node.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!row) return Number.POSITIVE_INFINITY;
    const view = node.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return Math.abs(box.top + box.height / 2 - (view.top + view.height / 2)) / view.height;
  }, TARGET_ID);
}

function distanceFromBottom(page: Page) {
  return scroller(page).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
}

function focusedMessageId(page: Page) {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.messageId ?? null,
  );
}

/** The conversation opened at the match: centred, highlighted and focused, not at the end. */
async function expectOpenedAtMatch(page: Page) {
  await expect(page).toHaveURL(new RegExp(`/chat/${THREAD_ID}\\?message=${TARGET_ID}$`));
  await expect(target(page)).toBeInViewport();
  await expect.poll(() => offCentre(page)).toBeLessThan(0.25);
  await expect(target(page)).toHaveAttribute('data-search-target', '');
  await expect.poll(() => focusedMessageId(page)).toBe(TARGET_ID);
  expect(await distanceFromBottom(page)).toBeGreaterThan(64);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  // The highlight is brief.
  await expect
    .poll(() => target(page).getAttribute('data-search-target'), { timeout: 5_000 })
    .toBeNull();
  // Late layout must not have pulled the view back to the end.
  await expect.poll(() => offCentre(page)).toBeLessThan(0.25);
}

test('sidebar search shows the matching line and opens the conversation at it', async ({
  page,
}) => {
  const queries: string[] = [];
  await installApi(page, queries);
  await signIn(page);

  const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
  if (await openSidebar.isVisible()) await openSidebar.click();

  await page.getByRole('textbox', { name: 'Search your conversations', exact: true }).fill('quok');

  const results = page.getByRole('list', { name: 'Search results' });
  const result = results.getByRole('link', { name: /Search fixture conversation/ });
  await expect(result).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '1 conversation found.' }),
  ).toBeAttached();
  expect(new Set(queries)).toEqual(new Set(['quok']));

  await expect(result.locator('mark')).toHaveText('quokka');
  // Markup in a message is shown as text, never rendered.
  await expect(result).toContainText('<b>Rottnest</b> Island');
  await expect(result.locator('b')).toHaveCount(0);
  await expect(result).toContainText('Archived');

  await result.click();
  await expectOpenedAtMatch(page);
});

test('the command palette opens a match from the keyboard', async ({ page }) => {
  await installApi(page, []);
  await signIn(page);

  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Type a command or search your conversations' });
  await expect(input).toBeFocused();
  await input.fill('quokka');

  const option = page.getByRole('option', { name: /Search fixture conversation/ });
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect(option.locator('mark')).toHaveText('quokka');

  await input.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
  await expectOpenedAtMatch(page);
});

test('the highlight is a still outline when reduced motion is preferred', async ({ page }) => {
  await installApi(page, []);
  await signIn(page);
  const highlightStyle = () =>
    target(page).evaluate((node) => {
      const style = getComputedStyle(node);
      return { animation: style.animationName, outline: style.outlineStyle };
    });

  await page.goto(`/chat/${THREAD_ID}?message=${TARGET_ID}`);
  await expect(target(page)).toHaveAttribute('data-search-target', '');
  expect((await highlightStyle()).animation).toBe('oci-search-target');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/chat/${THREAD_ID}?message=${TARGET_ID}`);
  await expect(target(page)).toHaveAttribute('data-search-target', '');
  expect(await highlightStyle()).toEqual({ animation: 'none', outline: 'solid' });
  await expect.poll(() => offCentre(page)).toBeLessThan(0.25);
});

test('a conversation without a message to open at still opens at its end', async ({ page }) => {
  await installApi(page, []);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}?message=not-in-this-thread`);
  await expect(page.locator('[data-message-id="history-59"]')).toBeAttached();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(64);
  await expect(page.locator('[data-search-target]')).toHaveCount(0);
});
