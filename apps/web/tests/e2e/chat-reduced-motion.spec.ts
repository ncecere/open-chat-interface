import { expect, type Page, test } from '@playwright/test';
import { signIn } from './accessibility.helpers';

/**
 * State-driven animations stop for a person who asked for reduced motion (#401, WCAG 2.3.3 and
 * consistency with the reply work block). The waiting dots that show while a reply has not
 * begun are the one a page shows long enough to check: jsdom has no CSS, so the unit tests read
 * the class, and this reads what a real browser computes from it.
 *
 * Self-contained: the catalog and the conversation are routed, and the reply never arrives, so
 * the dots stay.
 */
const THREAD_ID = 'reduced-motion-thread';
const MODEL = {
  id: 'model-motion',
  slug: 'motion-model',
  displayName: 'Motion model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'motion-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

async function waitForAReply(page: Page) {
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [],
        replies: [],
      }),
    }),
  );
  // The reply is never sent: the page waits for it, with the dots.
  await page.route('**/api/chat', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return new Promise<void>(() => {});
  });
  await page.goto(`/chat/${THREAD_ID}`);
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.fill('Hello');
  await composer.press('Enter');
  const waiting = page.getByRole('status', { name: 'Generating response' });
  await expect(waiting).toBeVisible();
  return waiting;
}

const animationOf = (page: Page) =>
  page.evaluate(() => {
    const dot = document.querySelector('[role="status"][aria-label] > span');
    return dot ? getComputedStyle(dot).animationName : null;
  });

test('the waiting dots bounce, and stop when reduced motion is asked for', async ({ page }) => {
  await signIn(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitForAReply(page);
  // Without the preference the dots move (the control: the test can tell the difference).
  await expect.poll(() => animationOf(page)).toBe('bounce');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => animationOf(page)).toBe('none');
  // The reply status below them is still the live region, motion or not.
  await expect(page.locator('[data-reply-status]')).toHaveText('The assistant is replying.');
});
