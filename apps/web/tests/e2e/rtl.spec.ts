import { expect, test } from '@playwright/test';
import { scan } from './accessibility.helpers';
import {
  ADMIN_SWEEP,
  adminCredentials,
  expectNoOverflow,
  openMixedConversation,
  readingOrderProblems,
  SWEEP,
  shot,
  signedInState,
  THREAD_TITLE,
  tabOrder,
  usePseudoLocale,
  WIDTHS,
} from './rtl.helpers';

/**
 * Right-to-left (v0.14, #397), looked at in a real browser with the forced
 * right-to-left pseudo-locale `ar-XB` (English text in right-to-left runs, so the
 * mirrored layout can be checked without reading Arabic; chosen per device with
 * `oci.pseudoLocale`, which the build for these tests allows). Real Arabic is
 * checked in language.spec.ts, which owns the instance's enabled languages.
 *
 * Mechanically: no horizontal overflow at 320, 768 and 1280 px on every page of
 * the sweep (rtl.helpers.ts), the sidebar on the right, focus in reading order
 * on sign-in. Screenshots go to /tmp/v014/rtl-shots (looked at, not committed).
 *
 * The person is the seeded administrator (which also lets the administration
 * console be swept: it stays English but must not be half mirrored); the one
 * conversation title it makes is removed again.
 */

let storage: Awaited<ReturnType<typeof signedInState>>;
let threadId = '';
let projectId = '';
const PROJECT_NAME = 'مشروع المكتبة · Library project';

test.beforeAll(async ({ browser }) => {
  // The forced right-to-left pseudo-locale exists only in a build made with
  // VITE_OCI_PSEUDO_LOCALES=1 (docs/dev/testing.md): say so rather than fail on a layout.
  const probe = await browser.newPage();
  await usePseudoLocale(probe, 'ar-XB');
  await probe.goto('/auth/login');
  await probe.locator('input[type="email"]').waitFor();
  const lang = await probe.evaluate(() => document.documentElement.lang);
  await probe.close();
  expect(
    lang,
    'No pseudo-locales in this build: build the web app with VITE_OCI_PSEUDO_LOCALES=1',
  ).toBe('ar-XB');

  const admin = adminCredentials();
  storage = await signedInState(browser, admin.email, admin.password);
  const context = await browser.newContext({ storageState: storage });
  const created = await context.request.post('/api/threads', { data: { title: THREAD_TITLE } });
  expect(created.ok(), await created.text()).toBe(true);
  const body = (await created.json()) as { id?: string; thread?: { id: string } };
  threadId = body.thread?.id ?? body.id ?? '';
  expect(threadId).not.toBe('');
  const project = await context.request.post('/api/projects', {
    data: { name: PROJECT_NAME },
  });
  expect(project.ok(), await project.text()).toBe(true);
  projectId = ((await project.json()) as { project: { id: string } }).project.id;
  await context.close();
});

test.afterAll(async ({ browser }) => {
  // Removed again: a thread goes to the trash first, then is deleted for good.
  const context = await browser.newContext({ storageState: storage });
  if (threadId) {
    const trashed = await context.request.delete(`/api/threads/${threadId}`);
    expect(trashed.ok(), `trash thread: ${trashed.status()} ${await trashed.text()}`).toBe(true);
    const removed = await context.request.delete(`/api/threads/${threadId}/permanent`);
    expect(removed.ok(), `delete thread: ${removed.status()} ${await removed.text()}`).toBe(true);
  }
  // Only the project this run made, by its id. The spec runs under both browser projects at
  // once, each with a project of this name, and a clean-up by name removed the other's.
  if (projectId) {
    const deleted = await context.request.delete(`/api/projects/${projectId}`);
    expect(deleted.ok(), `delete project: ${deleted.status()} ${await deleted.text()}`).toBe(true);
  }
  await context.close();
});

test.beforeEach(async ({ context, page }) => {
  await usePseudoLocale(page, 'ar-XB');
  await context.addCookies(storage.cookies);
});

for (const entry of [...SWEEP, ...ADMIN_SWEEP]) {
  for (const width of WIDTHS) {
    test(`${entry.name} has no horizontal overflow at ${width} px`, async ({ page, context }) => {
      if (!entry.signedIn) await context.clearCookies();
      await page.setViewportSize({ width, height: 900 });
      await entry.open(page, { threadId });
      expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar-XB');
      await expectNoOverflow(page, `${entry.name} at ${width}`);
      await shot(page, entry.name, width);
    });
  }
}

test('the sidebar is on the right at a desktop width, and the page opens from the right', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('textarea')).toBeVisible();
  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();
  const box = (await sidebar.boundingBox())!;
  const composer = (await page.locator('textarea').boundingBox())!;
  // Flush with the right edge, and the conversation to its left.
  expect(Math.round(box.x + box.width)).toBe(1280);
  expect(composer.x + composer.width).toBeLessThanOrEqual(box.x + 1);
  expect(composer.x).toBeLessThan(box.x);
  await shot(page, 'sidebar-right', 1280);
});

test('the sidebar drawer slides in from the right on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await expect(page.locator('textarea')).toBeVisible();
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();
  // The slide-in has finished once the right edge is the screen's.
  await expect
    .poll(async () => {
      const box = await sidebar.boundingBox();
      return box ? Math.round(box.x + box.width) : -1;
    })
    .toBe(390);
  await shot(page, 'drawer-right', 390);
});

test('keyboard focus follows the reading order on the sign-in page (right to left, top to bottom)', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/auth/login');
  await expect(page.locator('input[type="email"]')).toBeVisible();
  const stops = await tabOrder(page);
  expect(stops.length).toBeGreaterThanOrEqual(3);
  // Email, then password, then the buttons: the page's reading order, top to bottom.
  const labels = stops.map((stop) => `${stop.kind}:${stop.label}`);
  const kinds = stops.map((stop) => stop.kind);
  expect(kinds.slice(0, 3), labels.join(' | ')).toEqual(['email', 'password', 'submit']);
  expect(readingOrderProblems(stops, true), labels.join(' | ')).toEqual([]);
});

test('a conversation puts the person’s Arabic and English each in its own direction', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMixedConversation(page, threadId);
  const reply = page.locator(`[data-message-id="${threadId}-a"]`);
  // The first paragraph starts with Arabic: its text runs right to left and starts at the right.
  const paragraph = reply.locator('p').first();
  expect(await paragraph.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl');
  // Code stays left to right even in a right-to-left page.
  const code = reply.locator('[data-streamdown="code-block"]').first();
  expect(await code.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr');
  const inline = reply.locator('code', { hasText: 'library_id' });
  expect(await inline.evaluate((element) => getComputedStyle(element).direction)).toBe('ltr');
  // The person's own message follows its first letter too.
  const question = page.locator(`[data-message-id="${threadId}-q"]`);
  await expect(question).toContainText('المكتبة');
  await shot(page, 'conversation-mixed-detail', 1280);
});

test('the sign-in page and the chat home pass axe in the forced right-to-left locale', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto('/auth/login');
  await expect(page.locator('input[type="email"]')).toBeVisible();
  const signIn = await scan(page);
  expect(signIn.violations, JSON.stringify(signIn.violations.map((v) => v.id))).toEqual([]);
  await context.addCookies(storage.cookies);
  await page.goto('/');
  await expect(page.locator('textarea')).toBeVisible();
  const home = await scan(page);
  expect(home.violations, JSON.stringify(home.violations.map((v) => v.id))).toEqual([]);
});
