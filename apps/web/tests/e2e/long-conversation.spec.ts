import { expect, type Page, test } from '@playwright/test';

/**
 * Long conversations (v0.11, item 21) against the real API: the browser
 * fixture's 2,000-message conversation ("Fixture: long-conversation") opens
 * at its latest page, loads earlier pages as the reader scrolls up without
 * moving what they read, renders only the rows near the view once it is long,
 * still streams a reply at the bottom, and opens at a search result far from
 * the end.
 */

// Each test signs in, opens a 2,000-message conversation and scrolls up
// through hundreds of turns step by step (a pause and a measurement each),
// which takes about 25 s on a 2-CPU CI runner before any streaming. The app's
// own steps stay fast (opening: under 1 s); the budget is for the walk.
test.describe.configure({ timeout: 90_000 });

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

async function longThreadId(page: Page): Promise<string> {
  const response = await page.request.get('/api/threads?search=long-conversation');
  expect(response.ok()).toBe(true);
  const { threads } = (await response.json()) as { threads: Array<{ id: string; title: string }> };
  const thread = threads.find((candidate) => candidate.title === 'Fixture: long-conversation');
  if (!thread) throw new Error('The browser fixture has no long conversation');
  return thread.id;
}

/** The turn number of the first message in sight, and where the view is. */
function view(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-conversation-scroller]')!;
    const box = scroller.getBoundingClientRect();
    const first = [...document.querySelectorAll('article')].find((article) => {
      const rect = article.getBoundingClientRect();
      return rect.bottom > box.top + 80 && rect.top < box.bottom;
    });
    const match = first?.textContent?.match(/Long conversation (?:reply|question) (\d+)/);
    return {
      turn: match ? Number(match[1]) : null,
      articles: document.querySelectorAll('article').length,
      fromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });
}

/** Scrolls up a step at a time until the first message in sight is at or before `turn`. */
async function scrollUpTo(page: Page, turn: number) {
  let previous = (await view(page)).turn;
  for (let step = 0; step < 600; step++) {
    await page
      .locator('[data-conversation-scroller]')
      .evaluate((scroller) => scroller.scrollBy(0, -450));
    await page.waitForTimeout(40);
    const current = (await view(page)).turn;
    if (current !== null && previous !== null) {
      // Never forwards, never more than a few turns at once: no jump while
      // earlier pages arrive above.
      expect(current).toBeLessThanOrEqual(previous);
      expect(previous - current).toBeLessThanOrEqual(3);
    }
    previous = current ?? previous;
    if (previous !== null && previous <= turn) return;
  }
  throw new Error(`Did not reach turn ${turn}`);
}

test('opens at the latest page and loads earlier pages while scrolling up, keeping the place', async ({
  page,
}) => {
  await signIn(page);
  const id = await longThreadId(page);
  await page.goto(`/chat/${id}`);
  // (Another test may have added a turn after reply 1000.)
  await expect(page.getByText('Long conversation reply 1000', { exact: true })).toBeAttached();
  // One page of the 2,000 messages, fully rendered.
  await expect(page.locator('article')).toHaveCount(100);
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeAttached();
  expect((await view(page)).fromBottom).toBeLessThan(70);

  // Three pages back: the transcript is now windowed.
  await scrollUpTo(page, 850);
  expect((await view(page)).articles).toBeLessThan(60);
  // Ctrl+F only finds rendered messages; the last reply is no longer in the page.
  await expect(page.getByText('Long conversation reply 1000', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(page.getByRole('article').last()).toBeInViewport();
  await expect.poll(async () => (await view(page)).fromBottom).toBeLessThan(70);
});

test('offers earlier messages to the keyboard and announces each load', async ({ page }) => {
  await signIn(page);
  await page.goto(`/chat/${await longThreadId(page)}`);
  await expect(page.getByText('Long conversation reply 1000', { exact: true })).toBeAttached();
  const load = page.getByRole('button', { name: /Load(ing)? earlier messages/ });
  await load.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'earlier in the conversation' }),
  ).toHaveText(/Loaded 100 messages earlier in the conversation\./);
  // Focus stays on the control, which stays above the loaded messages.
  await expect(load).toBeFocused();
});

test('streams a reply at the bottom of a windowed transcript', async ({ page }) => {
  await signIn(page);
  await page.goto(`/chat/${await longThreadId(page)}`);
  await expect(page.getByText('Long conversation reply 1000', { exact: true })).toBeAttached();
  await scrollUpTo(page, 870);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(async () => (await view(page)).fromBottom).toBeLessThan(70);

  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill('One more question for the long conversation.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 30_000,
  });
  const last = page.getByRole('article', { name: 'Assistant message' }).last();
  await expect(last).toContainText('Local fixture section 32');
  // Followed to the end of the reply, still windowed.
  await expect.poll(async () => (await view(page)).fromBottom).toBeLessThan(70);
  expect((await view(page)).articles).toBeLessThan(80);
});

test('opens at a search result far from the end, with the gap between loadable', async ({
  page,
}) => {
  await signIn(page);
  const id = await longThreadId(page);
  const all = await page.request.get(`/api/chat/${id}/messages`);
  const { messages } = (await all.json()) as { messages: Array<{ id: string }> };
  const target = messages[200]!; // Question 101.
  await page.goto(`/chat/${id}?message=${target.id}`);

  const article = page.locator(`[data-message-id="${target.id}"]`);
  await expect(article).toContainText('Long conversation question 101');
  await expect(article).toBeInViewport();
  await expect(article).toBeFocused();
  // The latest messages are loaded too, below a gap.
  await expect(page.getByRole('button', { name: 'Load more messages' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeAttached();

  await page.getByRole('button', { name: 'Load more messages' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Loaded \d+ messages\.$/ })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(page.getByRole('article').last()).toBeInViewport();
  await expect.poll(async () => (await view(page)).fromBottom).toBeLessThan(70);
});
