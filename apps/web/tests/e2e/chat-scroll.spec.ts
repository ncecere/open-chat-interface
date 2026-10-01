import { expect, type Page, test } from '@playwright/test';

/**
 * Runs against the browser fixture's deterministic local provider, which
 * streams a long Markdown reply in many chunks, and its seeded 100-message
 * conversations.
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

const scroller = (page: Page) => page.locator('[data-conversation-scroller]');

/** Distance from the bottom of the conversation, in pixels. */
function distanceFromBottom(page: Page) {
  return scroller(page).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
}

/** Where a message's top sits relative to the top of the conversation view. */
function topInView(page: Page, text: string) {
  return scroller(page).evaluate((node, wanted) => {
    const rows = [...node.querySelectorAll<HTMLElement>('[aria-label="Your message"]')].reverse();
    const row = rows.find((element) => element.textContent?.includes(wanted));
    return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
  }, text);
}

/** Seeded 100-message conversations are titled "Fixture: history-NN". */
/** The message at the top of the view and where it sits, to compare reading positions. */
function visibleAnchor(page: Page) {
  return scroller(page).evaluate((node) => {
    const viewTop = node.getBoundingClientRect().top;
    const rows = [...node.querySelectorAll<HTMLElement>('[data-message-id]')];
    const row = rows.find((element) => element.getBoundingClientRect().bottom > viewTop + 1);
    return {
      id: row?.dataset.messageId ?? null,
      top: row ? row.getBoundingClientRect().top - viewTop : 0,
    };
  });
}

async function openLongConversation(page: Page, title: string) {
  const link = page.locator('a[href^="/chat/"]', { hasText: title }).first();
  const href = await link.getAttribute('href');
  if (!href) throw new Error('The browser fixture should seed long conversations');
  await page.goto(href);
  await expect(page.locator('[data-message-id]').first()).toBeVisible();
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(text);
  await input.press('Enter');
}

test('a sent question moves to the top and the view follows the reply', async ({ page }) => {
  await signIn(page);
  await openLongConversation(page, 'Fixture: history-01');

  // A long conversation opens at its end.
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(64);

  await send(page, 'Scroll behaviour question one');

  // The question moves to the top of the view before the reply fills it.
  await expect
    .poll(() => topInView(page, 'Scroll behaviour question one'), { timeout: 5_000 })
    .not.toBeNull();
  const pinnedTop = await topInView(page, 'Scroll behaviour question one');
  expect(pinnedTop).toBeGreaterThanOrEqual(0);
  expect(pinnedTop).toBeLessThan(80);

  // Once the reply outgrows the view, the view follows it: the question
  // scrolls away and the end of the reply stays in sight.
  await expect
    .poll(() => topInView(page, 'Scroll behaviour question one'), { timeout: 15_000 })
    .toBeLessThan(0);
  // A chunk can land in the frame before the view catches up, so allow a
  // moment rather than sampling once.
  await expect.poll(() => distanceFromBottom(page), { timeout: 2_000 }).toBeLessThanOrEqual(64);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 20_000,
  });
});

test('scrolling up stops following until the reader jumps back', async ({ page }) => {
  await signIn(page);
  await openLongConversation(page, 'Fixture: history-02');
  await send(page, 'Scroll behaviour question two');
  await expect
    .poll(() => topInView(page, 'Scroll behaviour question two'), { timeout: 5_000 })
    .not.toBeNull();

  // The reader scrolls back through the conversation while the reply streams.
  await scroller(page).hover();
  await page.mouse.wheel(0, -1500);
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  const readingAt = await visibleAnchor(page);

  // The reply finishes without dragging the reader back down. Earlier rows may
  // re-render at a different height when the reply settles, and the browser's
  // scroll anchoring then adjusts scrollTop, so compare what is on screen.
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 20_000,
  });
  const stillReading = await visibleAnchor(page);
  expect(stillReading.id).toBe(readingAt.id);
  expect(Math.abs(stillReading.top - readingAt.top)).toBeLessThan(40);
  expect(await distanceFromBottom(page)).toBeGreaterThan(64);
  await expect(jump).toBeVisible();

  await jump.click();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(64);
  await expect(jump).toHaveCount(0);
});

test('a conversation started from the home page also follows its first reply', async ({ page }) => {
  await signIn(page);
  await send(page, 'Scroll behaviour from home');
  await expect(page).toHaveURL(/\/chat\//);
  await expect
    .poll(() => topInView(page, 'Scroll behaviour from home'), { timeout: 15_000 })
    .toBeLessThan(0);
  // A chunk can land in the frame before the view catches up, so allow a
  // moment rather than sampling once.
  await expect.poll(() => distanceFromBottom(page), { timeout: 2_000 }).toBeLessThanOrEqual(64);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 20_000,
  });
});
