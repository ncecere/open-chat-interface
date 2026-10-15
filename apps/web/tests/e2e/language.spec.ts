import { type Browser, expect, type Page, test } from '@playwright/test';

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
  const settings = await page.request.get('/api/admin/settings');
  const { emailVerificationRequired } = (await settings.json()) as {
    emailVerificationRequired: boolean;
  };
  const email = `language-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = `Disposable-${Math.random().toString(36).slice(2, 10)}-Pw1!`;
  try {
    if (emailVerificationRequired) {
      const lifted = await page.request.patch('/api/admin/settings', {
        data: { emailVerificationRequired: false },
      });
      expect(lifted.ok(), await lifted.text()).toBe(true);
    }
    const response = await page.request.post('/api/admin/users', {
      data: { email, name: 'Language Fixture', password, role: 'user' },
    });
    expect(response.status(), await response.text()).toBe(201);
  } finally {
    if (emailVerificationRequired) {
      await page.request.patch('/api/admin/settings', {
        data: { emailVerificationRequired: true },
      });
    }
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
  // Nothing to choose between: no picker (pseudo-locales exist only in test builds).
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveCount(0);
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
