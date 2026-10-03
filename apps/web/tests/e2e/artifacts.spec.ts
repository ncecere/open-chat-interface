import { expect, type Page, test } from '@playwright/test';

/**
 * Runtime checks of the artifact sandbox (v0.9): an HTML artifact cannot
 * read OCI's cookies, storage or DOM, cannot fetch, cannot open windows and
 * cannot navigate OCI; share links use the same frame.
 */
const THREAD_ID = 'artifact-thread';
const SLUG = 'artifact-share-slug';

const PROBE = `<!doctype html>
<title>Probe</title>
<body>
<pre id="out">pending</pre>
<a id="away" href="https://example.com/">Leave</a>
<script>
  const out = {};
  try { out.cookie = document.cookie; } catch (error) { out.cookie = 'blocked'; }
  try { out.storage = String(localStorage.length); } catch (error) { out.storage = 'blocked'; }
  try { out.parent = String(parent.document.title); } catch (error) { out.parent = 'blocked'; }
  try { out.top = String(top.location.href); } catch (error) { out.top = 'blocked'; }
  try { out.popup = window.open('https://example.com/') ? 'opened' : 'blocked'; } catch (error) { out.popup = 'blocked'; }
  document.getElementById('out').textContent = JSON.stringify(out);
  fetch('/api/me').then(
    () => { document.body.dataset.fetch = 'allowed'; },
    () => { document.body.dataset.fetch = 'blocked'; },
  );
  const image = new Image();
  image.onload = () => { document.body.dataset.image = 'loaded'; };
  image.onerror = () => { document.body.dataset.image = 'blocked'; };
  image.src = 'https://example.com/pixel.png';
</script>
</body>`;

const REPLY = ['Here is the probe:', '```html', PROBE, '```'].join('\n');

const ARTIFACT = {
  id: 'artifact-probe',
  threadId: THREAD_ID,
  messageId: 'answer',
  sourceKey: 'block:0',
  title: 'Probe',
  kind: 'html',
  currentVersion: 1,
  sizeBytes: PROBE.length,
  createdAt: '2026-01-01T00:00:01.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
};

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

async function expectSandboxed(page: Page) {
  const frameElement = page.locator('iframe[data-artifact-frame]');
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frameLocator('iframe[data-artifact-frame]');
  await expect(frame.locator('#out')).not.toHaveText('pending', { timeout: 15_000 });
  expect(JSON.parse((await frame.locator('#out').textContent()) ?? '{}')).toEqual({
    cookie: 'blocked',
    storage: 'blocked',
    parent: 'blocked',
    top: 'blocked',
    popup: 'blocked',
  });
  await expect(frame.locator('body')).toHaveAttribute('data-fetch', 'blocked');
  await expect(frame.locator('body')).toHaveAttribute('data-image', 'blocked');

  // A link cannot take OCI anywhere, nor replace the artifact.
  const before = page.url();
  await frame.locator('#away').click();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  await expect(frame.locator('#out')).toBeVisible();
}

test('HTML artifacts run in a sandbox that cannot reach OCI or the network', async ({
  page,
  isMobile,
}) => {
  await signIn(page);
  await page.route(`**/api/chat/${THREAD_ID}/messages`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [
          {
            id: 'question',
            role: 'user',
            parts: [{ type: 'text', text: 'Make a probe' }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
          },
          {
            id: 'answer',
            role: 'assistant',
            parts: [{ type: 'text', text: REPLY }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:01.000Z' },
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/artifacts?threadId=${THREAD_ID}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [ARTIFACT] }),
    }),
  );
  await page.route(`**/api/artifacts/${ARTIFACT.id}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifact: ARTIFACT,
        versions: [
          {
            version: 1,
            sizeBytes: PROBE.length,
            source: 'reply',
            messageId: 'answer',
            createdAt: ARTIFACT.createdAt,
          },
        ],
        content: PROBE,
      }),
    }),
  );
  await page.evaluate(() => localStorage.setItem('oci.e2e', 'secret'));

  await page.goto(`/chat/${THREAD_ID}`);
  const card = page.getByRole('button', { name: 'Open artifact: Probe' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  // Docked beside the conversation on wide screens; a dialog on phones.
  const panel = isMobile
    ? page.getByRole('dialog', { name: 'Probe' })
    : page.getByRole('complementary', { name: 'Probe' });
  await expect(panel).toBeVisible();
  if (!isMobile) await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectSandboxed(page);

  // Keyboard: Escape closes the panel and focus returns to the card. The
  // probe clicked inside the preview, and a sandboxed frame's key presses never
  // reach OCI's page, so focus moves back to a panel control first.
  await panel.getByRole('tab', { name: 'Preview' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(card).toBeFocused();
});

test('the sandbox host page refuses to run without a sandbox', async ({ page }) => {
  // The preview server sends none of the proxy's headers, so this checks the
  // page's own guard: framed without a sandbox (or opened directly) it would
  // run on OCI's origin, so it must write nothing.
  await page.goto('/auth/login');
  const ran = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.src = '/artifact-frame.html';
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    frame.contentWindow?.postMessage(
      { type: 'oci-artifact', html: '<script>window.parent.__artifactEscaped = true</script>' },
      '*',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    return (window as unknown as { __artifactEscaped?: boolean }).__artifactEscaped === true;
  });
  expect(ran).toBe(false);

  await page.goto('/artifact-frame.html');
  const direct = await page.evaluate(async () => {
    window.postMessage({ type: 'oci-artifact', html: '<p id="written">x</p>' }, '*');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return document.getElementById('written') !== null;
  });
  expect(direct).toBe(false);
});

test('share links render artifacts in the same sandbox', async ({ page }) => {
  await page.route(`**/api/share-links/${SLUG}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { title: 'Shared probe', sharedAt: '2026-01-01T00:00:00.000Z' },
        messages: [
          {
            id: 'answer',
            role: 'assistant',
            parts: [{ type: 'text', text: REPLY }],
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ],
        artifacts: [
          {
            messageId: 'answer',
            sourceKey: 'block:0',
            title: 'Probe',
            kind: 'html',
            version: 1,
            content: PROBE,
          },
        ],
        snapshot: false,
        expiresAt: null,
      }),
    }),
  );
  await page.goto(`/share/${SLUG}`);
  await page.getByRole('button', { name: 'Open artifact: Probe' }).click();
  await expect(page.getByRole('dialog', { name: 'Probe' })).toBeVisible();
  await expectSandboxed(page);
});
