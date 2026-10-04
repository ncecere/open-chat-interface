import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Watching an artifact being written (v0.9): a reply that creates an HTML
 * page through the `create_artifact` tool streams the call's input; on wide
 * screens the panel opens docked beside the conversation on the source as it
 * arrives and switches to the preview once saved, without taking focus from
 * the composer. On phones nothing opens by itself; the live card shows the
 * writing.
 *
 * Before the tool call the reply reasons, and it reasons again before its
 * answer. Everything before the answer is one work block (v0.10.1): while the
 * model thinks it is a collapsed "Thinking…" header with a small window of
 * the latest lines; while it writes, "Writing Sign-Up Page…" with the live
 * card below the block; once the answer starts, "Thought · created an
 * artifact". The card's details open inside the card. The saved artifact can
 * then be viewed full screen.
 *
 * Self-contained: the model catalog is routed and an in-page stand-in for the
 * chat and artifact APIs streams a real UI message stream. The reasoning and
 * the tool call each stop part-way until the test releases them, so "before
 * completion" is observable.
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
      const state = { saved: false, release: () => {}, releaseReasoning: () => {} };
      const released = new Promise<void>((resolve) => {
        state.release = resolve;
      });
      const reasoningReleased = new Promise<void>((resolve) => {
        state.releaseReasoning = resolve;
      });
      Object.assign(window, {
        __releaseArtifact: () => state.release(),
        __releaseReasoning: () => state.releaseReasoning(),
      });
      const reasoning = [
        'REASONING_FIRST: the person wants a sign-up page.',
        ...Array.from(
          { length: 20 },
          (_, index) => `Step ${index + 1}: weigh one more detail of the form.`,
        ),
        'REASONING_LATEST: write it as one HTML page.',
      ];
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
              controller.enqueue(event({ type: 'reasoning-start', id: 'thought' }));
              for (const line of reasoning) {
                await pause();
                controller.enqueue(
                  event({ type: 'reasoning-delta', id: 'thought', delta: `${line}\n` }),
                );
              }
              await reasoningReleased;
              controller.enqueue(event({ type: 'reasoning-end', id: 'thought' }));
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
              controller.enqueue(event({ type: 'reasoning-start', id: 'thought-2' }));
              controller.enqueue(
                event({
                  type: 'reasoning-delta',
                  id: 'thought-2',
                  delta: 'REASONING_SECOND: tell them it is ready.',
                }),
              );
              controller.enqueue(event({ type: 'reasoning-end', id: 'thought-2' }));
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

/** The element covers the whole viewport. */
async function expectFillsViewport(page: Page, element: Locator) {
  const viewport = page.viewportSize()!;
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - viewport.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.height - viewport.height)).toBeLessThanOrEqual(1);
}

/**
 * The finished reply: one collapsed work block ("Thought · created an
 * artifact"), not two "Reasoning" headers around the card; the card below
 * the block and above the answer; expanded, a timeline of both reasoning
 * runs and a one-line row for the artifact.
 */
async function expectOneWorkBlock(reply: Locator) {
  const header = reply.locator('[data-reply-group] > button[aria-expanded]');
  await expect(header).toHaveCount(1);
  await expect(header).toHaveText('Thought · created an artifact');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(reply.getByRole('button', { name: 'Reasoning', exact: true })).toHaveCount(0);
  await expect(reply.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0);
  const order = await reply.evaluate((article) => {
    const at = (selector: string) => article.querySelector(selector);
    const block = at('[data-reply-group="work"]');
    const card = at('[data-artifact-card="tool:live-call"]');
    const text = at('[data-reply-group="text"]');
    const follows = (a: Element | null, b: Element | null) =>
      Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      inside: Boolean(block?.contains(card)),
      ordered: follows(block, card) && follows(card, text),
    };
  });
  expect(order).toEqual({ inside: false, ordered: true });
  await header.click();
  const steps = reply.getByRole('list', { name: 'Steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(3);
  await expect(steps).toContainText('REASONING_FIRST');
  await expect(steps).toContainText('REASONING_SECOND');
  await expect(
    steps.getByRole('button', { name: /Created artifact 'Sign-Up Page'/ }),
  ).toBeVisible();
  await expect(steps.locator('[data-artifact-card]')).toHaveCount(0);
  await header.click();
  await expect(steps).toHaveCount(0);
}

/** The card's own chevron opens its details inside the card's border. */
async function expectDetailsInCard(reply: Locator) {
  const toggle = reply.getByRole('button', { name: 'Show details for Sign-Up Page' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const step = reply.locator('[data-artifact-step="live-call"]');
  const before = await step.boundingBox();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const details = step.locator('[data-artifact-details]');
  await expect(details).toContainText('Title');
  await expect(details.getByRole('button', { name: 'Open artifact (version 1)' })).toBeVisible();
  const after = await step.boundingBox();
  const inside = await details.boundingBox();
  // The card grew to hold the details, within its own width.
  expect(before && after && inside && after.height > before.height).toBe(true);
  expect(
    inside && after && inside.x >= after.x && inside.x + inside.width <= after.x + after.width + 1,
  ).toBe(true);
  await toggle.click();
  await expect(details).toHaveCount(0);
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

  // Reasoning: a collapsed "Thinking…" header with a decorative window of
  // the latest lines, not the full text.
  const header = reply.locator('[data-reply-group] > button[aria-expanded]');
  await expect(header).toHaveCount(1);
  await expect(header).toHaveText('Thinking…');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  const tail = reply.locator('[data-reasoning-preview]');
  await expect(tail).toContainText('REASONING_LATEST: write it as one HTML page.');
  await expect(tail).toHaveAttribute('aria-hidden', 'true');
  await expect(tail).not.toContainText('REASONING_FIRST');
  await expect(reply.getByText('Some models hide parts of their thinking')).toHaveCount(0);
  const tailBox = await tail.boundingBox();
  // About three lines, below the header.
  expect(tailBox && tailBox.height > 30 && tailBox.height < 80).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { __releaseReasoning: () => void }).__releaseReasoning(),
  );
  // Writing: the same header names the artifact, the window is gone, and the
  // live card is below the block, not inside it.
  await expect(header).toHaveText('Writing Sign-Up Page…');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(tail).toHaveCount(0);
  const block = reply.locator('[data-reply-group="work"]');
  await expect(block.locator('[data-artifact-card]')).toHaveCount(0);

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
    const card = reply.getByRole('button', { name: 'Open artifact: Sign-Up Page' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectOneWorkBlock(reply);
    await expectDetailsInCard(reply);

    // Full screen from the phone dialog: Escape leaves full screen, then closes.
    await card.click();
    const sheet = page.getByRole('dialog', { name: 'Sign-Up Page' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Full screen', exact: true }).click();
    await expect(sheet).toHaveAttribute('data-full-screen', '');
    await expect(sheet.getByRole('button', { name: 'Exit full screen' })).toBeFocused();
    await expectFillsViewport(page, sheet);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toHaveAttribute('data-full-screen', '');
    await expect(sheet.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card).toBeFocused();
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
  const card = reply.getByRole('button', { name: 'Open artifact: Sign-Up Page' });
  await expect(card).toBeVisible();
  await expect(composer).toBeFocused();
  await expectOneWorkBlock(reply);
  await expectDetailsInCard(reply);

  // Full screen: a modal dialog over the whole window, above the sidebar and
  // top bar, with the preview filling it. Escape leaves full screen, then closes.
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'Sign-Up Page' });
  await expect(full).toBeVisible();
  await expect(full).toHaveAttribute('aria-modal', 'true');
  await expect(full.getByRole('button', { name: 'Exit full screen' })).toBeFocused();
  await expectFillsViewport(page, full);
  const viewport = page.viewportSize()!;
  const frameBox = await full.locator('iframe[data-artifact-frame]').boundingBox();
  expect(frameBox && frameBox.width >= viewport.width - 2).toBe(true);
  expect(frameBox && frameBox.height >= viewport.height - 200).toBe(true);
  // The top bar's corner is covered by the panel; the conversation is inert.
  expect(
    await page.evaluate(() =>
      Boolean(document.elementFromPoint(4, 4)?.closest('[data-artifact-panel]')),
    ),
  ).toBe(true);
  await expect(
    page.locator('[data-conversation-scroller]').locator('xpath=ancestor::*[@inert]'),
  ).not.toHaveCount(0);
  // Tab stays inside the panel.
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[data-artifact-panel]'))),
    ).toBe(true);
  }
  await full.getByRole('button', { name: 'Exit full screen' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(card).toBeFocused();
  await card.click();
  await expect(panel).toBeVisible();

  // The composer stays usable beside the panel, and Close closes it.
  await composer.fill('Thanks');
  await expect(composer).toHaveValue('Thanks');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
});
