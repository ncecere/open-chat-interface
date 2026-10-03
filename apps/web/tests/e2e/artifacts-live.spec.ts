import { expect, type Page, test } from '@playwright/test';

/**
 * Watching an artifact being written (v0.9): a reply that creates an HTML
 * page through the `create_artifact` tool streams the call's input; on wide
 * screens the panel opens docked beside the conversation on the source as it
 * arrives and switches to the preview once saved, without taking focus from
 * the composer. On phones nothing opens by itself; the live card shows the
 * writing.
 *
 * Self-contained: the model catalog is routed and an in-page stand-in for the
 * chat and artifact APIs streams a real UI message stream. The tool call stops
 * part-way until the test releases it, so "before completion" is observable.
 */

const THREAD_ID = 'live-artifact-thread';
const MODEL = {
  id: 'model-live-artifact',
  slug: 'live-artifact-model',
  displayName: 'Live artifact model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'live-artifact-model',
  capabilities: ['tool_calling'],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

async function installChatApi(page: Page) {
  await page.route('**/api/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [MODEL] }) }),
  );
  await page.addInitScript(
    ({ threadId }) => {
      const created = '2026-01-01T00:00:00.000Z';
      const page = [
        '<!doctype html>',
        '<html><head><title>Sign-Up Page</title></head>',
        '<body>',
        '<h1 id="heading">LIVE_FORM_HEADING</h1>',
        '<form><label>Email <input type="email"></label></form>',
        '</body></html>',
      ].join('\n');
      const input = JSON.stringify({ title: 'Sign-Up Page', kind: 'html', content: page });
      // Everything up to the form arrives first; the rest waits for the test.
      const cut = input.indexOf('<form>');
      const artifact = {
        id: 'live-artifact',
        threadId,
        messageId: 'live-reply',
        sourceKey: 'tool:live-call',
        title: 'Sign-Up Page',
        kind: 'html',
        currentVersion: 1,
        sizeBytes: page.length,
        createdAt: created,
        updatedAt: created,
      };
      const state = { saved: false, release: () => {} };
      const released = new Promise<void>((resolve) => {
        state.release = resolve;
      });
      Object.assign(window, { __releaseArtifact: () => state.release() });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      const original = window.fetch.bind(window);

      window.fetch = async (request, init) => {
        const url = new URL(
          typeof request === 'string'
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
          location.href,
        );
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.pathname === `/api/chat/${threadId}/messages` && method === 'GET')
          return json({
            thread: { id: threadId, temporary: false, expiresAt: null },
            messages: [],
            replies: [],
          });
        if (url.pathname === '/api/artifacts' && method === 'GET')
          return json({ artifacts: state.saved ? [artifact] : [] });
        if (url.pathname === `/api/artifacts/${artifact.id}` && method === 'GET')
          return json({
            artifact,
            versions: [
              {
                version: 1,
                sizeBytes: page.length,
                source: 'reply',
                messageId: 'live-reply',
                createdAt: created,
              },
            ],
            content: page,
          });
        if (url.pathname === '/api/chat' && method === 'POST') {
          const encoder = new TextEncoder();
          const event = (data: unknown) =>
            encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
          const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
          const pieces = (text: string) => text.match(/[\s\S]{1,12}/g) ?? [];
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(event({ type: 'start', messageId: 'live-reply' }));
              controller.enqueue(event({ type: 'start-step' }));
              controller.enqueue(
                event({
                  type: 'tool-input-start',
                  toolCallId: 'live-call',
                  toolName: 'create_artifact',
                  title: 'Create artifact',
                }),
              );
              for (const delta of pieces(input.slice(0, cut))) {
                await pause();
                controller.enqueue(
                  event({
                    type: 'tool-input-delta',
                    toolCallId: 'live-call',
                    inputTextDelta: delta,
                  }),
                );
              }
              await released;
              for (const delta of pieces(input.slice(cut))) {
                controller.enqueue(
                  event({
                    type: 'tool-input-delta',
                    toolCallId: 'live-call',
                    inputTextDelta: delta,
                  }),
                );
              }
              controller.enqueue(
                event({
                  type: 'tool-input-available',
                  toolCallId: 'live-call',
                  toolName: 'create_artifact',
                  input: JSON.parse(input),
                  title: 'Create artifact',
                }),
              );
              state.saved = true;
              controller.enqueue(
                event({
                  type: 'tool-output-available',
                  toolCallId: 'live-call',
                  output: {
                    artifactId: artifact.id,
                    title: artifact.title,
                    kind: 'html',
                    version: 1,
                    sizeBytes: page.length,
                  },
                }),
              );
              controller.enqueue(event({ type: 'finish-step' }));
              controller.enqueue(event({ type: 'start-step' }));
              controller.enqueue(event({ type: 'text-start', id: 'text' }));
              controller.enqueue(
                event({ type: 'text-delta', id: 'text', delta: 'Your sign-up page is ready.' }),
              );
              controller.enqueue(event({ type: 'text-end', id: 'text' }));
              controller.enqueue(event({ type: 'finish-step' }));
              controller.enqueue(event({ type: 'finish', finishReason: 'stop' }));
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
        return original(request, init);
      };
    },
    { threadId: THREAD_ID },
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

test('an artifact is watched as it is written, docked on wide screens only', async ({
  page,
  isMobile,
}) => {
  await installChatApi(page);
  await signIn(page);
  await page.goto(`/chat/${THREAD_ID}`);
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.fill('Make a sign-up page');
  await composer.press('Enter');

  const reply = page.getByRole('article', { name: 'Assistant message' });
  const liveCard = reply.locator('[data-artifact-card="tool:live-call"]');
  await expect(liveCard).toContainText('Writing Sign-Up Page…');
  await expect(liveCard).toHaveAttribute('data-live', '');
  // The card shows the text growing, whether or not the panel is open.
  await expect(liveCard).toContainText(/HTML · \d+ lines/);
  await expect(liveCard.locator('[data-live-preview]')).toContainText('LIVE_FORM_HEADING');
  const panel = page.getByRole('complementary', { name: 'Sign-Up Page' });

  if (isMobile) {
    // Phones: nothing opens by itself.
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() =>
      (window as unknown as { __releaseArtifact: () => void }).__releaseArtifact(),
    );
    await expect(reply).toContainText('Your sign-up page is ready.');
    await expect(reply.getByRole('button', { name: 'Open artifact: Sign-Up Page' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    return;
  }

  // Wide screens: the panel opens beside the conversation on the source,
  // before the call is complete, and focus stays in the composer.
  await expect(panel).toBeVisible();
  const source = panel.getByRole('region', { name: 'Source of Sign-Up Page' });
  await expect(source).toContainText('LIVE_FORM_HEADING');
  await expect(source).not.toContainText('<form>');
  await expect(source).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(composer).toBeFocused();
  const box = await panel.boundingBox();
  const conversation = await page.locator('[data-conversation-scroller]').boundingBox();
  expect(box && conversation && box.x >= conversation.x + conversation.width - 1).toBe(true);

  await page.evaluate(() =>
    (window as unknown as { __releaseArtifact: () => void }).__releaseArtifact(),
  );
  // Saved: the panel switches to the preview in the sandboxed frame.
  await expect(panel.getByRole('tab', { name: 'Preview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const frame = panel.locator('iframe[data-artifact-frame]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('iframe[data-artifact-frame]').locator('#heading')).toHaveText(
    'LIVE_FORM_HEADING',
  );
  await expect(reply).toContainText('Your sign-up page is ready.');
  await expect(reply.getByRole('button', { name: 'Open artifact: Sign-Up Page' })).toBeVisible();
  await expect(composer).toBeFocused();

  // The composer stays usable beside the panel, and Close closes it.
  await composer.fill('Thanks');
  await expect(composer).toHaveValue('Thanks');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
});
