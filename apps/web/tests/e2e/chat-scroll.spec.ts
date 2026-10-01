import { expect, type Page, test } from '@playwright/test';

/**
 * Chat scroll behaviour against a long conversation and a reply that streams
 * in many chunks over a few seconds.
 *
 * Self-contained so it runs on any seeded instance (CI has no model provider):
 * the model catalog is routed, and an in-page stand-in for the chat API serves
 * history and streams the reply as a real UI message stream, chunk by chunk.
 */

const THREAD_ID = 'scroll-thread';
const NEW_THREAD_ID = 'scroll-new-thread';

const MODEL = {
  id: 'model-scroll',
  slug: 'scroll-model',
  displayName: 'Scroll model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'scroll-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

/** Installs the in-page chat API before any application code runs. */
async function installChatApi(page: Page) {
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.addInitScript(
    ({ threadId, newThreadId }) => {
      const paragraph =
        'Streaming reply text that is long enough to wrap across several lines on a phone and on a desktop, so the reply grows well beyond one screen. ';
      const created = '2026-01-01T00:00:00.000Z';
      const threads: Record<string, unknown[]> = {
        [threadId]: Array.from({ length: 100 }, (_, index) => ({
          id: `history-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: `History ${index}. ${paragraph.repeat(3)}` }],
          metadata: { status: 'complete', createdAt: created },
        })),
        [newThreadId]: [],
      };
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      const original = window.fetch.bind(window);

      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        const method = (init?.method ?? 'GET').toUpperCase();
        const history = url.pathname.match(/^\/api\/chat\/([^/]+)\/messages$/);
        if (history && method === 'GET' && history[1] && history[1] in threads) {
          return json({
            thread: { id: history[1], temporary: false, expiresAt: null },
            messages: threads[history[1]],
          });
        }
        if (url.pathname === '/api/threads' && method === 'POST') {
          return json({
            thread: {
              id: newThreadId,
              title: 'New Chat',
              pinned: false,
              archived: false,
              temporary: false,
              expiresAt: null,
              parentThreadId: null,
              branchedFromMessageId: null,
              lastMessageAt: null,
              createdAt: created,
              updatedAt: created,
            },
          });
        }
        if (url.pathname === '/api/chat' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          const thread = threads[body.threadId] ?? [];
          const prompt = body.messages?.[0];
          const assistantId = `assistant-${thread.length}`;
          const chunks = Array.from({ length: 60 }, () => paragraph);
          thread.push(
            { ...prompt, metadata: { status: 'complete', createdAt: created } },
            {
              id: assistantId,
              role: 'assistant',
              parts: [{ type: 'text', text: chunks.join('') }],
              metadata: { status: 'complete', createdAt: created },
            },
          );
          const encoder = new TextEncoder();
          const event = (data: unknown) =>
            encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(event({ type: 'start', messageId: assistantId }));
              controller.enqueue(event({ type: 'text-start', id: 'text' }));
              for (const delta of chunks) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                controller.enqueue(event({ type: 'text-delta', id: 'text', delta }));
              }
              controller.enqueue(event({ type: 'text-end', id: 'text' }));
              controller.enqueue(event({ type: 'finish' }));
              controller.enqueue(event('[DONE]'));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'x-vercel-ai-ui-message-stream': 'v1',
            },
          });
        }
        return original(input, init);
      };
    },
    { threadId: THREAD_ID, newThreadId: NEW_THREAD_ID },
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

/** Distance from the bottom of the conversation, in pixels. */
function distanceFromBottom(page: Page) {
  return scroller(page).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
}

/** Where a question's top sits relative to the top of the conversation view. */
function topInView(page: Page, text: string) {
  return scroller(page).evaluate((node, wanted) => {
    const rows = [...node.querySelectorAll<HTMLElement>('[aria-label="Your message"]')].reverse();
    const row = rows.find((element) => element.textContent?.includes(wanted));
    return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
  }, text);
}

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

async function openLongConversation(page: Page) {
  await page.goto(`/chat/${THREAD_ID}`);
  await expect(page.locator('[data-message-id="history-99"]')).toBeAttached();
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(text);
  await input.press('Enter');
}

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const jumpButton = (page: Page) => page.getByRole('button', { name: 'Jump to latest' });

/** A chunk can land in the frame before the view catches up; allow a moment. */
async function expectFollowing(page: Page) {
  await expect.poll(() => distanceFromBottom(page), { timeout: 2_000 }).toBeLessThanOrEqual(64);
  await expect(jumpButton(page)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await installChatApi(page);
  await signIn(page);
});

test('a sent question moves to the top and the view follows the reply', async ({ page }) => {
  await openLongConversation(page);

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

  // Once the reply outgrows the view, the view follows it.
  await expect
    .poll(() => topInView(page, 'Scroll behaviour question one'), { timeout: 15_000 })
    .toBeLessThan(0);
  await expectFollowing(page);
  await expect(stopButton(page)).toHaveCount(0, { timeout: 20_000 });
  await expectFollowing(page);
});

test('scrolling up stops following until the reader jumps back', async ({ page }) => {
  await openLongConversation(page);
  await send(page, 'Scroll behaviour question two');
  await expect
    .poll(() => topInView(page, 'Scroll behaviour question two'), { timeout: 5_000 })
    .not.toBeNull();

  // The reader scrolls back through the conversation while the reply streams.
  await scroller(page).hover();
  await page.mouse.wheel(0, -1500);
  await expect(jumpButton(page)).toBeVisible();
  const readingAt = await visibleAnchor(page);

  // The reply finishes without dragging the reader back down. Rows may
  // re-render at a different height when the reply settles, and the browser's
  // scroll anchoring then adjusts scrollTop, so compare what is on screen.
  await expect(stopButton(page)).toHaveCount(0, { timeout: 20_000 });
  const stillReading = await visibleAnchor(page);
  expect(stillReading.id).toBe(readingAt.id);
  expect(Math.abs(stillReading.top - readingAt.top)).toBeLessThan(40);
  expect(await distanceFromBottom(page)).toBeGreaterThan(64);
  await expect(jumpButton(page)).toBeVisible();

  await jumpButton(page).click();
  await expectFollowing(page);
});

test('a conversation started from the home page also follows its first reply', async ({ page }) => {
  await send(page, 'Scroll behaviour from home');
  await expect(page).toHaveURL(new RegExp(`/chat/${NEW_THREAD_ID}$`));
  await expect
    .poll(() => topInView(page, 'Scroll behaviour from home'), { timeout: 15_000 })
    .toBeLessThan(0);
  await expectFollowing(page);
  await expect(stopButton(page)).toHaveCount(0, { timeout: 20_000 });
});
