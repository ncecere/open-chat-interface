import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * "Searched the web" inside the reply's work block (v0.11): a search made
 * before the reply (the Search toggle with a model not offered the web search
 * tool) and the links a connector returned are steps of the one block, so a
 * reply has at most one disclosure above its answer, and its sources stay a
 * click or two away. Self-contained: the conversation is routed.
 */

const THREAD_ID = 'web-search-step-thread';
const created = '2026-01-01T00:00:00.000Z';
const MODEL = {
  id: 'model-search-step',
  slug: 'search-step-model',
  displayName: 'Search step model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'search-step-model',
  capabilities: ['reasoning'],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};
const metadata = { modelSlug: MODEL.slug, status: 'complete', createdAt: created };
const user = (id: string, text: string) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { status: 'complete', createdAt: created },
});
const results = [
  {
    title: 'Library hours',
    url: 'https://library.example/hours',
    snippet: 'Opens at 9 on weekdays',
  },
  { title: 'City guide', url: 'https://city.example/guide', snippet: 'Hours vary in summer' },
];

async function installServer(page: Page) {
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
              {
                type: 'data-search-grounding',
                id: 'search-grounding-1',
                data: { query: 'library opening hours', results, provider: 'SearXNG' },
              },
              ...results.map((result, index) => ({
                type: 'source-url',
                sourceId: `search-${index + 1}`,
                url: result.url,
                title: result.title,
              })),
              { type: 'step-start' },
              { type: 'reasoning', text: 'Both sources agree on weekdays.' },
              { type: 'text', text: 'It opens at 9 on weekdays.' },
            ],
            metadata,
          },
          user('prompt-2', 'Look up my library account'),
          {
            id: 'reply-2',
            role: 'assistant',
            parts: [
              { type: 'step-start' },
              {
                type: 'tool-mcp__library__lookup',
                toolCallId: 'lookup-1',
                state: 'output-available',
                input: { card: '1234' },
                output: { loans: 2 },
              },
              {
                type: 'source-url',
                sourceId: 'search-3',
                url: 'https://library.example/account',
                title: 'Your account',
              },
              { type: 'step-start' },
              { type: 'text', text: 'You have two loans.' },
            ],
            metadata,
          },
        ],
        replies: [],
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

/** Disclosures of a reply above its first run of text. */
async function disclosuresAboveAnswer(reply: Locator) {
  return reply.evaluate((article) => {
    const answer = article.querySelector('[data-reply-group="text"]');
    return [...article.querySelectorAll('button[aria-expanded]')].filter(
      (button) =>
        answer &&
        button.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING &&
        button.getAttribute('aria-expanded') === 'false',
    ).length;
  });
}

test('folds the search before a reply into its work block, sources inside', async ({ page }) => {
  await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);
  const reply = page.getByRole('article', { name: 'Assistant message' }).first();
  await expect(reply).toContainText('It opens at 9 on weekdays.');

  // One disclosure above the answer, summarising the search and the thinking.
  expect(await disclosuresAboveAnswer(reply)).toBe(1);
  const header = reply.locator('[data-reply-group="work"] > button');
  await expect(header).toHaveText('Searched the web · thought');
  await expect(reply).not.toContainText('Search Grounding Details');
  await expect(reply.getByRole('button', { name: /Library hours/ })).toHaveCount(0);

  await header.click();
  const steps = reply.getByRole('list', { name: 'Steps' });
  const search = steps.getByRole('button', { name: 'Searched the web · 2 sources' });
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await search.click();
  await expect(reply).toContainText('library opening hours');
  await expect(reply).toContainText('SearXNG');
  // Each source opens through the external-link check, as before.
  const source = reply.getByRole('list', { name: 'Sources' }).getByRole('button').first();
  await expect(source).toContainText('Library hours');
  await expect(source).toContainText('https://library.example/hours');
  await expect(reply).toContainText('Opens at 9 on weekdays');
  // The search ran first, so it is the timeline's first step.
  await expect(steps.locator(':scope > li').first()).toHaveAttribute('data-work-entry', 'search');
  // The reply still says it used the web.
  await expect(reply.getByLabel('Web search used')).toBeVisible();
});

test('keeps a connector’s links in the block as a sources step', async ({ page }) => {
  await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);
  const reply = page.getByRole('article', { name: 'Assistant message' }).nth(1);
  await expect(reply).toContainText('You have two loans.');
  expect(await disclosuresAboveAnswer(reply)).toBe(1);
  await expect(reply.getByRole('button', { name: 'Searched the web' })).toHaveCount(0);

  await reply.locator('[data-reply-group="work"] > button').click();
  const sources = reply.getByRole('button', { name: 'Sources · 1 link' });
  await sources.click();
  await expect(reply.getByRole('button', { name: /Your account/ })).toContainText(
    'https://library.example/account',
  );
});
