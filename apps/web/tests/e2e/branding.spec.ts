import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Branding applied everywhere (v0.10), in a real browser against the real API.
 *
 * An administrator sets a name, a colour theme, a sign-in message and an
 * uploaded logo through the admin API, and every surface is checked: the tab
 * title and icon, the sidebar header, the colour theme, the sign-in page and a
 * public share page. Removing the logo brings back the Open Chat Interface
 * mark and icons. The original branding is restored afterwards.
 */

/** A 1x1 PNG: enough for the server's content check, and unlike any default icon. */
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const SHARE_SLUG = 'branding-e2e-share';

function adminCredentials() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

async function signIn(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

/**
 * Branding is instance-wide, and the desktop and mobile projects may run this
 * file at the same time; a directory lock keeps one run's settings from
 * landing in the middle of the other's assertions. A lock older than two
 * minutes belongs to a run that died and is taken over.
 */
async function withBrandingLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), 'oci-e2e-branding.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 120_000) rmSync(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

interface Branding {
  appName: string;
  shortName: string | null;
  logoUrl: string | null;
  colorTheme: string;
  loginMessage: string | null;
  defaultTheme: string;
}

async function patchSettings(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.patch('/api/admin/settings', { data });
  expect(response.ok(), await response.text()).toBe(true);
}

test('custom branding reaches every surface', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page);

  await withBrandingLock(async () => {
    const before = (await (await page.request.get('/api/admin/settings')).json()) as Branding;
    const appName = `Acme ${Math.random().toString(36).slice(2, 6)}`;
    const loginMessage = `Welcome to ${appName}.`;

    try {
      await patchSettings(page.request, {
        appName,
        shortName: null,
        colorTheme: 'violet',
        loginMessage,
      });
      const upload = await page.request.post('/api/admin/settings/logo', {
        multipart: { file: { name: 'logo.png', mimeType: 'image/png', buffer: LOGO_PNG } },
      });
      expect(upload.ok(), await upload.text()).toBe(true);

      // The logo is served same-origin to anyone, for the sign-in page and the tab.
      const logo = await page.request.get('/api/branding/logo');
      expect(logo.status()).toBe(200);
      expect(logo.headers()['content-type']).toBe('image/png');

      // Chat: tab title, tab icons, sidebar header (also the mobile drawer), theme.
      await page.goto('/');
      await expect(page).toHaveTitle(appName);
      for (const icon of await page.locator('link[data-brand-icon]').all())
        await expect(icon).toHaveAttribute('href', '/api/branding/logo');
      await expect(page.locator('aside img[data-wordmark="logo"]')).toHaveAttribute('alt', appName);
      await expect(page.locator('html')).toHaveAttribute('data-color-theme', 'violet');

      // Admin pages are named in the tab.
      await page.goto('/admin/branding');
      await expect(page).toHaveTitle(`Branding · Admin · ${appName}`);

      // A public share page: the header and tab follow branding. The share
      // itself is stubbed; what is under test is the page around it.
      await page.route(`**/api/share-links/${SHARE_SLUG}`, (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            thread: { title: 'Branded share', sharedAt: new Date().toISOString() },
            messages: [],
            snapshot: true,
            expiresAt: null,
          }),
        }),
      );
      await page.goto(`/share/${SHARE_SLUG}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Branded share' })).toBeVisible();
      await expect(page).toHaveTitle(`Branded share · ${appName}`);
      await expect(page.locator('header img[data-wordmark="logo"]')).toHaveAttribute(
        'alt',
        appName,
      );

      // Someone signed out sees the same branding on the sign-in page.
      const visitor = await browser.newContext();
      try {
        const anonymous = await visitor.newPage();
        await anonymous.goto('/auth/login');
        await expect(anonymous).toHaveTitle(`Sign in · ${appName}`);
        await expect(anonymous.getByRole('img', { name: appName })).toHaveAttribute(
          'src',
          '/api/branding/logo',
        );
        await expect(anonymous.getByText(loginMessage)).toBeVisible();
        await expect(anonymous.locator('link[data-brand-icon]').first()).toHaveAttribute(
          'href',
          '/api/branding/logo',
        );
      } finally {
        await visitor.close();
      }

      // Without a logo, the Turns mark sits beside the name, and the icons return.
      await patchSettings(page.request, { logoUrl: null });
      await page.goto('/');
      await expect(page).toHaveTitle(appName);
      const wordmark = page.locator('aside [data-wordmark="mark"]');
      await expect(wordmark).toHaveText(appName);
      await expect(wordmark.locator('svg[data-brand-mark="turns"]')).toHaveCount(1);
      await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
        'href',
        '/favicon.svg',
      );
      const favicon = await page.request.get('/favicon.svg');
      expect(favicon.ok()).toBe(true);
      expect(await favicon.text()).toContain('#51a2ff');
    } finally {
      // An uploaded original reads back as the public URL and cannot be put
      // back by value; anything else is restored exactly.
      const restoreLogo =
        before.logoUrl === '/api/branding/logo' ? {} : { logoUrl: before.logoUrl };
      await patchSettings(page.request, {
        appName: before.appName,
        shortName: before.shortName,
        colorTheme: before.colorTheme,
        loginMessage: before.loginMessage,
        defaultTheme: before.defaultTheme,
        ...restoreLogo,
      });
    }
  });
});
