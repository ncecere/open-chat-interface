import { expect, type Page, test } from '@playwright/test';

/**
 * Switching between retried replies on the latest turn.
 *
 * Self-contained so it runs on any seeded instance (CI has no model provider):
 * the model catalog, the conversation, the retry stream and the switch API are
 * routed, backed by a small in-test server state, so a reload shows what the
 * server would have saved.
 */

const THREAD_ID = 'reply-switch-thread';
const created = '2026-01-01T00:00:00.000Z';
const MODEL = {
  id: 'model-replies',
  slug: 'replies-model',
  displayName: 'Replies model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'replies-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

const prompt = {
  id: 'prompt',
  role: 'user',
  parts: [{ type: 'text', text: 'Name a colour' }],
  metadata: { status: 'complete', createdAt: created },
};
const reply = (id: string, text: string) => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  metadata: { modelSlug: MODEL.slug, status: 'complete', createdAt: created },
});

/** Routes the conversation APIs, recording every switch and retry the page makes. */
async function installServer(page: Page) {
  const server = {
    replies: [reply('reply-1', 'First answer: red'), reply('reply-2', 'Second answer: green')],
    active: 'reply-2',
    switches: [] as string[],
    retries: [] as Array<{ trigger: string; messages: Array<{ id?: string }> }>,
  };
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/messages`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [prompt, server.replies.find((entry) => entry.id === server.active)],
        replies: server.replies,
      }),
    }),
  );
  await page.route(`**/api/threads/${THREAD_ID}/messages/*/active`, async (route) => {
    expect(route.request().method()).toBe('PATCH');
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    server.switches.push(id);
    server.active = id;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activeMessageId: id }),
    });
  });
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    server.retries.push(route.request().postDataJSON());
    const id = `reply-${server.replies.length + 1}`;
    const text = 'Third answer: blue';
    server.replies.push(reply(id, text));
    server.active = id;
    const events = [
      { type: 'start', messageId: id, messageMetadata: { modelSlug: MODEL.slug } },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: text },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-OCI-Chat-Run-Id': id,
        'X-OCI-Prompt-Message-Id': prompt.id,
      },
      body: `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    });
  });
  return server;
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

const assistant = (page: Page) => page.getByRole('article', { name: 'Assistant message' });
const replies = (page: Page) => page.getByRole('group', { name: 'Replies' });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous reply' });
const next = (page: Page) => page.getByRole('button', { name: 'Next reply' });

test('switches between retried replies, retries again and reloads the chosen reply', async ({
  page,
}) => {
  const server = await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);

  // The active reply is shown with its position among the turn's replies.
  await expect(assistant(page)).toHaveCount(1);
  await expect(assistant(page)).toContainText('Second answer: green');
  await expect(replies(page)).toContainText('2 / 2');
  await expect(replies(page).getByRole('status')).toHaveText('Reply 2 of 2');
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');

  // Switching updates the transcript at once and saves the choice.
  await previous(page).click();
  await expect(assistant(page)).toContainText('First answer: red');
  await expect(assistant(page)).not.toContainText('green');
  await expect(replies(page).getByRole('status')).toHaveText('Reply 1 of 2');
  await expect.poll(() => server.switches).toEqual(['reply-1']);

  // Keyboard operable; focus stays on the control when it becomes unavailable.
  await next(page).focus();
  await page.keyboard.press('Enter');
  await expect(assistant(page)).toContainText('Second answer: green');
  await expect(next(page)).toBeFocused();
  await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => server.switches).toEqual(['reply-1', 'reply-2']);

  // A retry adds a third reply and keeps the earlier two reachable.
  await assistant(page).hover();
  await assistant(page).getByRole('button', { name: 'Retry' }).click();
  await expect(assistant(page)).toContainText('Third answer: blue');
  await expect(replies(page).getByRole('status')).toHaveText('Reply 3 of 3');
  expect(server.retries).toHaveLength(1);
  expect(server.retries[0]?.trigger).toBe('regenerate-message');
  expect(server.retries[0]?.messages[0]?.id).toBe(prompt.id);

  await previous(page).click();
  await expect(assistant(page)).toContainText('Second answer: green');
  await expect.poll(() => server.switches).toEqual(['reply-1', 'reply-2', 'reply-2']);

  // A reload shows the reply that was chosen last.
  await page.reload();
  await expect(assistant(page)).toContainText('Second answer: green');
  await expect(replies(page)).toContainText('2 / 3');
  await expect(assistant(page)).toHaveCount(1);
});
