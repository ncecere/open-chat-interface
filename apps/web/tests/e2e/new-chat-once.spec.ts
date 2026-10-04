import { expect, type Page, test } from '@playwright/test';

/**
 * One send from the new-chat page starts exactly one conversation (v0.10.2).
 *
 * In v0.10.1 the home page kept its draft and an enabled Send button until the
 * navigation to the new conversation committed, and nothing stopped a second
 * send while the first was still creating its thread. Every Enter that reached
 * the composer in that window was another POST /api/threads; an automated
 * browser that flooded the page with key events left one person with thousands
 * of empty "New Chat" conversations and a hung tab.
 *
 * These drive the real page with trusted (CDP) key events and count requests.
 * Sign-in is real; the catalog, thread and chat APIs are an in-page stand-in so
 * the test cannot fill the shared account with conversations if it regresses,
 * and thread creation is slowed so key presses land while it is pending.
 */

const MODEL = {
  id: 'model-new-chat-once',
  slug: 'new-chat-once-model',
  displayName: 'New chat once model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'new-chat-once-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

interface Recorded {
  threadCreates: number;
  chatSends: string[];
  /** Every distinct pathname the app moved to, in order. */
  paths: string[];
}

async function installApi(page: Page, createDelayMs: number) {
  await page.addInitScript(
    ({ model, createDelayMs }) => {
      const now = () => new Date().toISOString();
      const threads: Array<Record<string, unknown>> = [];
      const messages: Record<string, unknown[]> = {};
      const recorded = { threadCreates: 0, chatSends: [] as string[], paths: [] as string[] };
      Object.assign(window, { __newChatOnce: recorded });
      const track = () => {
        if (recorded.paths.at(-1) !== location.pathname) recorded.paths.push(location.pathname);
      };
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method].bind(history);
        history[method] = (...args: Parameters<History['pushState']>) => {
          original(...args);
          track();
        };
      }

      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const original = window.fetch.bind(window);

      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = url.pathname;
        const body = () => JSON.parse(String(init?.body ?? '{}'));

        if (path === '/api/models') return json({ models: [model] });
        if (path === '/api/threads' && method === 'GET') return json({ threads });
        if (path === '/api/projects/sidebar' && method === 'GET') return json({ projects: [] });
        if (path === '/api/threads' && method === 'POST') {
          recorded.threadCreates += 1;
          const input = body();
          const thread = {
            id: `thread-once-${recorded.threadCreates}`,
            title: 'New Chat',
            pinned: false,
            archived: false,
            temporary: Boolean(input.temporary),
            expiresAt: null,
            parentThreadId: null,
            branchedFromMessageId: null,
            projectId: null,
            lastMessageAt: null,
            createdAt: now(),
            updatedAt: now(),
          };
          threads.unshift(thread);
          messages[thread.id as string] = [];
          await new Promise((resolve) => setTimeout(resolve, createDelayMs));
          return json({ thread }, 201);
        }
        const historyPath = path.match(/^\/api\/chat\/([^/]+)\/messages$/);
        if (historyPath && method === 'GET' && historyPath[1] && historyPath[1] in messages) {
          return json({
            thread: threads.find((candidate) => candidate.id === historyPath[1]),
            messages: messages[historyPath[1]],
          });
        }
        if (path === '/api/chat' && method === 'POST') {
          const request = body();
          const prompt = request.messages?.[0];
          recorded.chatSends.push(prompt?.parts?.[0]?.text ?? '');
          const assistantId = `assistant-${request.threadId}`;
          messages[request.threadId]?.push(
            { ...prompt, metadata: { status: 'complete', createdAt: now() } },
            {
              id: assistantId,
              role: 'assistant',
              parts: [{ type: 'text', text: 'One reply.' }],
              metadata: { status: 'complete', createdAt: now() },
            },
          );
          const encoder = new TextEncoder();
          const event = (data: unknown) =>
            encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(event({ type: 'start', messageId: assistantId }));
              controller.enqueue(event({ type: 'text-start', id: 'text' }));
              controller.enqueue(event({ type: 'text-delta', id: 'text', delta: 'One reply.' }));
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
    { model: MODEL, createDelayMs },
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

/** The desktop page lists suggested prompts; each starts a conversation too, so they wait as well. */
async function suggestionIfShown(page: Page) {
  const suggestion = page.getByRole('button', { name: 'How does AI work?' });
  if (!(await suggestion.isVisible())) return;
  await expect(suggestion).toBeDisabled();
  await suggestion.click({ force: true });
}

function recorded(page: Page): Promise<Recorded> {
  return page.evaluate(() => (window as unknown as { __newChatOnce: Recorded }).__newChatOnce);
}

/** Trusted Enter key-downs, as a browser driver delivers them, without waiting between them. */
async function floodEnter(page: Page, count: number) {
  const cdp = await page.context().newCDPSession(page);
  const enter = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  const sends: Promise<unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    // A stuck or held key: the first press, then auto-repeat, with a few
    // separate presses mixed in the way a driver retrying `press` would.
    const autoRepeat = index > 0 && index % 10 !== 0;
    sends.push(
      cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, autoRepeat, text: '\r' }),
    );
    if (!autoRepeat) sends.push(cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter }));
  }
  await Promise.all(sends);
  await cdp.detach();
}

test('a flood of Enter key presses on the new-chat page starts one conversation', async ({
  page,
}) => {
  await installApi(page, 600);
  await signIn(page);

  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.fill('Describe a lighthouse');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await composer.focus();

  await floodEnter(page, 200);
  await expect(page).toHaveURL(/\/chat\/thread-once-1$/);
  await expect(page.getByText('One reply.')).toBeVisible();
  // More presses after the conversation opened; its composer is empty.
  await floodEnter(page, 50);

  const result = await recorded(page);
  expect(result.threadCreates).toBe(1);
  expect(result.chatSends).toEqual(['Describe a lighthouse']);
  expect(result.paths.filter((path) => path.startsWith('/chat/'))).toEqual(['/chat/thread-once-1']);
});

test('Send is disabled while the conversation is being created', async ({ page }) => {
  await installApi(page, 4_000);
  await signIn(page);

  const composer = page.getByRole('textbox', { name: 'Message input' });
  const send = page.getByRole('button', { name: 'Send message' });
  await composer.fill('Plan a picnic');
  await send.click();
  // Creation is still pending: the page has not moved and cannot send again.
  await expect(send).toBeDisabled({ timeout: 1_000 });
  await composer.press('Enter');
  await send.click({ force: true });
  await suggestionIfShown(page);
  expect(new URL(page.url()).pathname).toBe('/');
  expect((await recorded(page)).threadCreates).toBe(1);

  await expect(page).toHaveURL(/\/chat\/thread-once-1$/, { timeout: 10_000 });
  await expect(page.getByText('One reply.')).toBeVisible();
  const result = await recorded(page);
  expect(result.threadCreates).toBe(1);
  expect(result.chatSends).toEqual(['Plan a picnic']);
});
