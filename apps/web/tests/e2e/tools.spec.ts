import { expect, type Page, test } from '@playwright/test';

/**
 * Tool steps and approvals in a conversation.
 *
 * Self-contained so it runs on any seeded instance (CI has no model provider):
 * the model catalog, the conversation and the approvals endpoint are routed,
 * backed by a small in-test server state, so a reload shows what the server
 * would have saved.
 */

const THREAD_ID = 'tools-thread';
const created = '2026-01-01T00:00:00.000Z';
const MODEL = {
  id: 'model-tools',
  slug: 'tools-model',
  displayName: 'Tools model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'tools-model',
  capabilities: ['tool_calling'],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

const user = (id: string, text: string) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { status: 'complete', createdAt: created },
});
const searchStep = {
  type: 'tool-web_search',
  toolCallId: 'search-1',
  state: 'output-available',
  input: { query: 'library opening hours' },
  output: {
    query: 'library opening hours',
    results: [
      { title: 'Library hours', url: 'https://library.example/hours', snippet: 'Opens at 9' },
      { title: 'City guide', url: 'https://city.example/guide', snippet: 'Varies' },
    ],
  },
};
const noteRequest = {
  type: 'tool-send_note',
  toolCallId: 'note-1',
  title: 'Send note',
  state: 'approval-requested',
  input: { to: 'Ada', text: 'The library opens at 9.' },
  approval: { id: 'approval-1' },
};

/** Routes the conversation APIs, recording every approval answer the page sends. */
async function installServer(page: Page) {
  const server = {
    answered: [] as unknown[],
    reply: {
      id: 'reply-2',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'I can send that note.' },
        noteRequest,
      ] as Record<string, unknown>[],
      metadata: { modelSlug: MODEL.slug, status: 'complete', createdAt: created },
    },
  };
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [
          user('prompt-1', 'When does the library open?'),
          {
            id: 'reply-1',
            role: 'assistant',
            parts: [
              { type: 'step-start' },
              searchStep,
              {
                type: 'source-url',
                sourceId: 'search-1',
                url: 'https://library.example/hours',
                title: 'Library hours',
              },
              { type: 'step-start' },
              { type: 'text', text: 'It opens at 9.' },
            ],
            metadata: { modelSlug: MODEL.slug, status: 'complete', createdAt: created },
          },
          user('prompt-2', 'Send Ada a note about it'),
          server.reply,
        ],
        replies: [],
      }),
    }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/approvals`, async (route) => {
    expect(route.request().method()).toBe('POST');
    server.answered.push(route.request().postDataJSON());
    const done = 'Sent the note to Ada.';
    server.reply = {
      ...server.reply,
      parts: [
        ...server.reply.parts.slice(0, 2),
        {
          ...noteRequest,
          state: 'output-available',
          output: { sent: true },
          approval: { id: 'approval-1', approved: true },
        },
        { type: 'step-start' },
        { type: 'text', text: done },
      ],
    };
    const events = [
      { type: 'start', messageId: 'reply-2', messageMetadata: { modelSlug: MODEL.slug } },
      { type: 'tool-output-available', toolCallId: 'note-1', output: { sent: true } },
      { type: 'start-step' },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: done },
      { type: 'text-end', id: 'text' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-OCI-Chat-Run-Id': 'reply-2:continue',
        'X-OCI-Prompt-Message-Id': 'prompt-2',
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

test('shows a search as a collapsed tool step that expands to its inputs and results', async ({
  page,
}) => {
  await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);

  // The reply's tool use is one collapsed block named for what it did.
  const block = assistant(page).first().locator('[data-reply-group="work"] > button');
  await expect(block).toHaveText('Searched the web');
  await expect(block).toHaveAttribute('aria-expanded', 'false');
  await expect(assistant(page).first()).toContainText('It opens at 9.');
  await block.click();
  await expect(block).toHaveAttribute('aria-expanded', 'true');
  const step = assistant(page)
    .first()
    .getByRole('list', { name: 'Steps' })
    .getByRole('button', { name: "Searched the web for 'library opening hours' · 2 results" });
  await expect(step).toHaveAttribute('aria-expanded', 'false');
  await expect(assistant(page).first()).not.toContainText('"query"');
  await step.click();
  await expect(step).toHaveAttribute('aria-expanded', 'true');
  // A search step shows its query as text, not the JSON inputs (#203).
  const details = assistant(page)
    .first()
    .locator(`[id="${await step.getAttribute('aria-controls')}"]`);
  await expect(details.getByText('Search query', { exact: true })).toBeVisible();
  await expect(details.getByText('library opening hours', { exact: true })).toBeVisible();
  await expect(assistant(page).first()).not.toContainText('"query"');
  await expect(details.getByText('City guide')).toBeVisible();
});

test('approves a tool call, continues the same reply and keeps it after a reload', async ({
  page,
}) => {
  // Phone width: the card and its buttons must fit without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);

  const card = page.getByRole('region', { name: 'Allow Send note?' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('"to": "Ada"');
  // The approval is in sight above the reply's text, not in a collapsed block.
  const above = await card.evaluate((element) => {
    const text = element.closest('article')?.querySelector('[data-reply-group="text"]');
    return Boolean(
      text && element.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(above).toBe(true);
  await expect(card.getByRole('status')).toHaveText('Send note is waiting for your approval.');
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);

  const approve = card.getByRole('button', { name: 'Approve' });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(assistant(page).last()).toContainText('Sent the note to Ada.');
  await expect(page.getByRole('region', { name: 'Allow Send note?' })).toHaveCount(0);
  // Run, the step joins the reply's work block, and focus stays with the reply.
  const work = assistant(page).last().locator('[data-reply-group="work"] > button');
  await expect(work).toHaveText('Used Send note');
  await expect(work).toBeFocused();
  await work.click();
  await expect(
    assistant(page)
      .last()
      .getByRole('list', { name: 'Steps' })
      .getByRole('button', { name: 'Used Send note' }),
  ).toBeVisible();
  // The same reply continued: still two replies on screen.
  await expect(assistant(page)).toHaveCount(2);
  expect(server.answered).toEqual([
    {
      messageId: 'reply-2',
      responses: [{ approvalId: 'approval-1', approved: true }],
      // The browser's zone, for the date the model is told (#248).
      timeZone: expect.any(String),
    },
  ]);

  await page.reload();
  await expect(assistant(page).last()).toContainText('Sent the note to Ada.');
  await expect(page.getByRole('region', { name: 'Allow Send note?' })).toHaveCount(0);
});

test('an approval waiting before a reload is still waiting after it', async ({ page }) => {
  await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);
  await expect(page.getByRole('region', { name: 'Allow Send note?' })).toBeVisible();
  await page.reload();
  const card = page.getByRole('region', { name: 'Allow Send note?' });
  await expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Deny' })).toBeEnabled();
});
