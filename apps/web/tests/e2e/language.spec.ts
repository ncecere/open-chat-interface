import { type Browser, expect, type Page, test } from '@playwright/test';
import { scan } from './accessibility.helpers';
import { whileVerificationLifted } from './fixtures/verification-lock';
import { expectNoOverflow, SWEEP, shot, THREAD_TITLE, WIDTHS } from './rtl.helpers';

/**
 * Languages (v0.14, #397) in a real browser against the real API: the picker in
 * Settings → Customization saves to the server and applies at once, <html lang
 * dir> follows (Arabic is right-to-left), the choice survives a reload and
 * another device, and a language the administrator switches off falls back.
 *
 * The people are disposable accounts, never the seeded administrator, and the
 * instance's enabled languages are put back afterwards.
 */

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in|iniciar|تسجيل/i }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function adminCredentials() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

async function adminPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const admin = adminCredentials();
  await signIn(page, admin.email, admin.password);
  return { context, page };
}

async function setEnabled(browser: Browser, enabled: string[]) {
  const { context, page } = await adminPage(browser);
  const response = await page.request.patch('/api/admin/settings', {
    data: { language: { enabled, default: null } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await context.close();
}

/** A fresh local account, made through the administration API (see settings-account.spec.ts). */
async function disposableUser(browser: Browser) {
  const { context, page } = await adminPage(browser);
  const email = `language-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = `Disposable-${Math.random().toString(36).slice(2, 10)}-Pw1!`;
  try {
    await whileVerificationLifted(page.request, async () => {
      const response = await page.request.post('/api/admin/users', {
        data: { email, name: 'Language Fixture', password, role: 'user' },
      });
      expect(response.status(), await response.text()).toBe(201);
    });
  } finally {
    await context.close();
  }
  return { email, password };
}

async function choose(page: Page, current: string, option: string) {
  await page.getByRole('combobox', { name: current }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const html = (page: Page) =>
  page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));

test.describe.configure({ mode: 'serial' });
test.afterAll(async ({ browser }) => {
  await setEnabled(browser, ['en']);
});

test('the picker is not offered while only English is enabled', async ({ browser }) => {
  await setEnabled(browser, ['en']);
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings/customization');
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  // Nothing to choose between: no picker in a production build, and in a build
  // with the pseudo-locales (VITE_OCI_PSEUDO_LOCALES=1, which rtl.spec.ts needs)
  // a picker that offers those and no real language but English.
  const picker = page.getByRole('combobox', { name: 'Language' });
  if ((await picker.count()) > 0) {
    await picker.click();
    const labels = await page.getByRole('option').allTextContents();
    expect(labels.filter((label) => /Español|العربية/.test(label))).toEqual([]);
    expect(labels.some((label) => /Pseudo-locale/.test(label))).toBe(true);
  }
  await context.close();
});

test('switches language at once, saves it, and Arabic turns the page right-to-left', async ({
  browser,
}) => {
  await setEnabled(browser, ['en', 'es', 'ar']);
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings/customization');
  expect(await html(page)).toEqual({ lang: 'en', dir: 'ltr' });

  await choose(page, 'Language', 'Español (beta)');
  await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible();
  expect(await html(page)).toEqual({ lang: 'es', dir: 'ltr' });
  await expect(page.getByText('borrador automático')).toBeVisible();

  // Kept on this device and on the server: a reload, and a second device.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible();
  expect(await html(page)).toEqual({ lang: 'es', dir: 'ltr' });
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, user.email, user.password);
  await otherPage.goto('/settings/customization');
  await expect(otherPage.getByRole('heading', { name: 'Idioma' })).toBeVisible();
  await other.close();

  await choose(page, 'Idioma', 'العربية (beta)');
  await expect(page.getByRole('heading', { name: 'اللغة' })).toBeVisible();
  expect(await html(page)).toEqual({ lang: 'ar', dir: 'rtl' });
  // Mirrored, and nothing pushed off the screen at a phone's width.
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Back to English through Automatic (the browser is English here).
  await choose(page, 'اللغة', 'تلقائي');
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  expect(await html(page)).toEqual({ lang: 'en', dir: 'ltr' });
  await context.close();
});

test('a language the administrator switches off falls back without an error', async ({
  browser,
}) => {
  await setEnabled(browser, ['en', 'es']);
  const user = await disposableUser(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  await page.goto('/settings/customization');
  await choose(page, 'Language', 'Español (beta)');
  await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible();

  await setEnabled(browser, ['en']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Customize your assistant' })).toBeVisible();
  expect(await html(page)).toEqual({ lang: 'en', dir: 'ltr' });

  // Switched on again, the saved choice applies again.
  await setEnabled(browser, ['en', 'es']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible();
  await context.close();
});

test('real Arabic mirrors every page: no overflow at 320, 768 and 1280 px, the sidebar on the right, axe clean', async ({
  browser,
}) => {
  // The pages and the measurements are the ones rtl.spec.ts runs in the forced
  // right-to-left pseudo-locale; here the language is real Arabic, chosen the
  // way a person does: saved on the account, and for a visitor the browser's.
  test.setTimeout(240_000);
  await setEnabled(browser, ['en', 'ar']);
  const user = await disposableUser(browser);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user.email, user.password);
  const saved = await page.request.patch('/api/me/preferences', { data: { locale: 'ar' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await page.request.post('/api/threads', { data: { title: THREAD_TITLE } });
  expect(created.ok(), await created.text()).toBe(true);
  const body = (await created.json()) as { id?: string; thread?: { id: string } };
  const threadId = body.thread?.id ?? body.id ?? '';
  expect(threadId).not.toBe('');
  await page.request.post('/api/projects', { data: { name: 'مشروع المكتبة · Library project' } });

  const visitor = await browser.newContext({ locale: 'ar-EG' });
  const visitorPage = await visitor.newPage();

  for (const width of WIDTHS) {
    for (const entry of SWEEP) {
      const target = entry.signedIn ? page : visitorPage;
      await target.setViewportSize({ width, height: 900 });
      await entry.open(target, { threadId });
      expect(await html(target), `${entry.name} at ${width}`).toEqual({ lang: 'ar', dir: 'rtl' });
      await expectNoOverflow(target, `${entry.name} at ${width} (ar)`);
      await shot(target, `ar-${entry.name}`, width);
    }
  }

  // The sidebar is on the right at a desktop width.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('textarea')).toBeVisible();
  const box = (await page.locator('aside').first().boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(1280);

  // axe in Arabic: the sign-in page (a visitor) and the chat home.
  await visitorPage.goto('/auth/login');
  await expect(visitorPage.locator('input[type="email"]')).toBeVisible();
  const signInResults = await scan(visitorPage);
  expect(
    signInResults.violations,
    JSON.stringify(signInResults.violations.map((v) => v.id)),
  ).toEqual([]);
  const homeResults = await scan(page);
  expect(homeResults.violations, JSON.stringify(homeResults.violations.map((v) => v.id))).toEqual(
    [],
  );

  await page.request.delete(`/api/threads/${threadId}`);
  await page.request.delete(`/api/threads/${threadId}/permanent`);
  await visitor.close();
  await context.close();
});
