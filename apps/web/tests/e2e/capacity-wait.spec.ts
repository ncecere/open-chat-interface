import { expect, type Page, test } from '@playwright/test';

/**
 * A reply waiting for its model's provider (v0.11, provider capacity).
 *
 * Self-contained like the reply switcher's test (CI has no model provider):
 * the catalog, the conversation, the reply stream and Stop are routed, backed
 * by a small in-test server state.
 */

const THREAD_ID = 'capacity-wait-thread';
const created = '2026-01-01T00:00:00.000Z';
const MODEL = {
  id: 'model-capacity',
  slug: 'capacity-model',
  displayName: 'Busy model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'capacity-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};
const capacity = (data: Record<string, unknown>) => ({
  type: 'data-capacity',
  id: 'capacity',
  data: { model: MODEL.displayName, estimatedWaitSeconds: null, waitedSeconds: 0, ...data },
});
const prompt = {
  id: 'prompt',
  role: 'user',
  parts: [{ type: 'text', text: 'Summarise the report' }],
  metadata: { status: 'complete', createdAt: created },
};

async function installServer(page: Page) {
  const server = {
    status: 'streaming' as 'streaming' | 'cancelled',
    stops: 0,
    sent: 0,
  };
  const waitingReply = () => ({
    id: 'waiting-reply',
    role: 'assistant',
    parts: [capacity({ state: 'waiting', position: 2, estimatedWaitSeconds: 45 })],
    metadata: { modelSlug: MODEL.slug, status: server.status, createdAt: created },
  });
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [prompt, waitingReply()],
        replies: [],
      }),
    }),
  );
  await page.route(`**/api/chat/${THREAD_ID}/stream`, async (route) => {
    if (route.request().method() === 'DELETE') {
      server.stops++;
      server.status = 'cancelled';
      return route.fulfill({ contentType: 'application/json', body: '{"cancelled":true}' });
    }
    // No live stream to join: the page follows the saved reply instead.
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    server.sent++;
    const id = `sent-${server.sent}`;
    const events = [
      { type: 'start', messageId: id, messageMetadata: { modelSlug: MODEL.slug } },
      capacity({ state: 'waiting', position: 1, estimatedWaitSeconds: 8 }),
      capacity({ state: 'admitted', position: null, waitedSeconds: 12 }),
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Here is the summary.' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-OCI-Chat-Run-Id': id,
        'X-OCI-Prompt-Message-Id': `prompt-${server.sent}`,
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

test('a waiting reply shows its place and can be stopped', async ({ page }) => {
  const server = await installServer(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);

  const waiting = assistant(page).locator('[data-capacity-wait]');
  await expect(waiting.getByRole('status')).toContainText(
    'Waiting for Busy model — you’re number 2',
  );
  await expect(waiting).toContainText('should start in about 45 seconds');
  await expect(page.getByRole('status', { name: 'Generating response' })).toHaveCount(0);

  await waiting.getByRole('button', { name: 'Stop waiting' }).click();
  await expect.poll(() => server.stops).toBeGreaterThan(0);
  await expect(waiting).toHaveCount(0, { timeout: 10_000 });
});

test('a reply that waited says so once it has started', async ({ page }) => {
  const server = await installServer(page);
  server.status = 'cancelled';
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);
  await page.getByRole('textbox', { name: 'Message input' }).fill('And the appendix?');
  await page.keyboard.press('Enter');
  const reply = assistant(page).last();
  await expect(reply).toContainText('Here is the summary.');
  await expect(reply).toContainText('Waited 12 seconds for Busy model.');
  await expect(reply.locator('[data-capacity-wait]')).toHaveCount(0);
});
