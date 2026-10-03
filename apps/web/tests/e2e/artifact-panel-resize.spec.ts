import { expect, type Page, test } from '@playwright/test';

/**
 * The docked artifact panel (v0.10) resizes from a drag handle on its left
 * edge, by pointer or keyboard, and the width is remembered in the browser.
 */
const THREAD_ID = 'artifact-resize-thread';
const DOC = '# Plan\n\nA short plan.';
const ARTIFACT = {
  id: 'artifact-resize',
  threadId: THREAD_ID,
  messageId: 'answer',
  sourceKey: 'tool:c1',
  title: 'Plan',
  kind: 'markdown',
  currentVersion: 1,
  sizeBytes: DOC.length,
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

async function routeConversation(page: Page) {
  await page.route(`**/api/chat/${THREAD_ID}/messages`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: THREAD_ID, temporary: false, expiresAt: null },
        messages: [
          {
            id: 'question',
            role: 'user',
            parts: [{ type: 'text', text: 'Write a plan' }],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
          },
          {
            id: 'answer',
            role: 'assistant',
            parts: [
              {
                type: 'tool-create_artifact',
                toolCallId: 'c1',
                state: 'output-available',
                input: { title: 'Plan', kind: 'markdown', content: DOC },
                output: {
                  artifactId: ARTIFACT.id,
                  title: 'Plan',
                  kind: 'markdown',
                  version: 1,
                  sizeBytes: DOC.length,
                },
              },
              { type: 'text', text: 'Here is the plan.' },
            ],
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
            sizeBytes: DOC.length,
            source: 'reply',
            messageId: 'answer',
            createdAt: ARTIFACT.createdAt,
          },
        ],
        content: DOC,
      }),
    }),
  );
}

test('the docked panel resizes by drag and keyboard, and remembers its width', async ({
  page,
  isMobile,
}) => {
  await signIn(page);
  if (isMobile) {
    // Phones keep the full-screen dialog, without a handle.
    await routeConversation(page);
    await page.goto(`/chat/${THREAD_ID}`);
    await page.getByRole('button', { name: 'Open artifact: Plan' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan' })).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Resize artifact panel' })).toHaveCount(0);
    return;
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('oci.artifacts.panelWidth'));
  await routeConversation(page);
  await page.goto(`/chat/${THREAD_ID}`);
  await page.getByRole('button', { name: 'Open artifact: Plan' }).click();
  const panel = page.getByRole('complementary', { name: 'Plan' });
  await expect(panel).toBeVisible();
  const handle = panel.getByRole('separator', { name: 'Resize artifact panel' });
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuemin', '352');
  await expect(handle).toHaveAttribute('aria-valuemax', String(Math.floor(1440 * 0.7)));
  const width = async () => Math.round((await panel.boundingBox())?.width ?? 0);
  const before = await width();
  // Until resized, the value is the measured default width.
  await expect(handle).toHaveAttribute('aria-valuenow', String(before));

  // Drag the left edge 120px to the left: the panel is 120px wider.
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await width()) - (before + 120))).toBeLessThanOrEqual(2);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('oci.artifacts.panelWidth')))
    .not.toBeNull();

  // Keyboard: Home is the narrowest, the arrows step, End the widest.
  await handle.focus();
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '352');
  expect(await width()).toBe(352);
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '384');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', String(Math.floor(1440 * 0.7)));
  await page.keyboard.press('ArrowRight');
  const kept = Math.floor(1440 * 0.7) - 32;
  await expect(handle).toHaveAttribute('aria-valuenow', String(kept));

  // Remembered after a reload.
  await page.reload();
  await page.getByRole('button', { name: 'Open artifact: Plan' }).click();
  await expect(panel).toBeVisible();
  expect(await width()).toBe(kept);

  // Full screen has no handle and fills the window.
  await panel.getByRole('button', { name: 'Full screen' }).click();
  await expect(page.getByRole('separator', { name: 'Resize artifact panel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit full screen' }).click();

  // A double click restores the default.
  await handle.dblclick();
  expect(Math.abs((await width()) - before)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => localStorage.getItem('oci.artifacts.panelWidth'))).toBeNull();
});
