import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, test as base, chromium, expect, type Page } from '@playwright/test';

/**
 * Installing the app (#400), in Chromium.
 *
 * Installability is proven rather than assumed: Chromium itself says, over the
 * DevTools protocol (`Page.getInstallabilityErrors`), what would stop the page
 * being installed. Two things make that answer mean something:
 *
 *  - The full browser (`channel: 'chromium'`, new headless mode). The headless
 *    shell Playwright uses by default does not run the installability check:
 *    it answers "no errors" for a page with no manifest at all.
 *  - A persistent profile. A default Playwright context is incognito, and an
 *    incognito window can never install, which the check reports as
 *    `in-incognito`.
 *
 * Each control below fails the check on purpose, so a pass is not vacuous. No
 * sign-in is needed: the sign-in page is where a visitor lands, and the
 * manifest is public.
 */

const test = base.extend<{ app: { context: BrowserContext; page: Page } }>({
  app: async ({ baseURL }, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'oci-installable-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      baseURL,
    });
    try {
      await use({ context, page: context.pages()[0] ?? (await context.newPage()) });
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
});

/** The application policy exactly as docker/Caddyfile sets it on every page but the artifact frame. */
function productionPolicy(): string {
  const caddyfile = readFileSync(new URL('../../../../docker/Caddyfile', import.meta.url), 'utf8');
  const block = caddyfile.match(/header @application \{([^}]*)\}/)?.[1] ?? '';
  const policy = block.match(/Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy)
    throw new Error('docker/Caddyfile no longer sets the application policy as expected');
  return policy;
}

/** Adds a policy to the sign-in page, as Caddy does in production; the preview server sets none. */
async function servePolicy(page: Page, policy: string) {
  await page.route(
    (url) => url.pathname === '/auth/login',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': policy },
      });
    },
  );
}

/** Serves the manifest changed by `change`, to see what Chromium says about it. */
async function changeManifest(page: Page, change: (manifest: Record<string, unknown>) => void) {
  await page.route('**/api/manifest.webmanifest', async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    change(manifest);
    await route.fulfill({ response, body: JSON.stringify(manifest) });
  });
}

async function cdp(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('Page.enable');
  return client;
}

/** The ids of what Chromium says would stop the page being installed. */
async function installabilityErrors(page: Page): Promise<string[]> {
  const { installabilityErrors } = await (await cdp(page)).send('Page.getInstallabilityErrors');
  return installabilityErrors.map((error) => error.errorId);
}

async function signInPage(page: Page) {
  await page.goto('/auth/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}

/** The width and height a PNG declares in its header. */
function pngSize(bytes: Buffer) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe('installable app', () => {
  test('Chromium reports nothing that stops the app being installed', async ({ app: { page } }) => {
    await signInPage(page);
    expect(await installabilityErrors(page)).toEqual([]);

    const manifest = await (await cdp(page)).send('Page.getAppManifest', {});
    expect(manifest.errors).toEqual([]);
    expect(manifest.url).toMatch(/\/api\/manifest\.webmanifest$/);
    expect(JSON.parse(manifest.data ?? '{}')).toMatchObject({
      display: 'standalone',
      start_url: '/',
      scope: '/',
    });
  });

  test('the check bites: Chromium names what is wrong with a manifest that is not good enough', async ({
    app: { page },
  }) => {
    await changeManifest(page, (manifest) => {
      manifest.icons = [];
      manifest.display = 'browser';
      delete manifest.name;
      delete manifest.short_name;
    });
    await signInPage(page);
    expect(await installabilityErrors(page)).toEqual(
      expect.arrayContaining([
        'manifest-missing-suitable-icon',
        'manifest-display-not-supported',
        'manifest-missing-name-or-short-name',
      ]),
    );
  });

  test('a single square icon of 512 px or more is enough, as an uploaded logo is', async ({
    app: { page },
  }) => {
    await changeManifest(page, (manifest) => {
      manifest.icons = (manifest.icons as Array<{ sizes: string; purpose: string }>).filter(
        (icon) => icon.sizes === '512x512' && icon.purpose === 'any',
      );
    });
    await signInPage(page);
    expect(await installabilityErrors(page)).toEqual([]);
  });

  test('the manifest and every icon it names are served, and the icons are the sizes it says', async ({
    app: { page },
  }) => {
    await signInPage(page);
    const link = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(link).toBe('/api/manifest.webmanifest');

    const response = await page.request.get(link as string);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^application\/manifest\+json/);
    expect(response.headers()['cache-control']).toBe('public, max-age=300');
    const manifest = await response.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    for (const icon of manifest.icons as Array<{ src: string; sizes: string; type: string }>) {
      expect(icon.src, 'icon URLs are same-origin').toMatch(/^\/[^/]/);
      const image = await page.request.get(icon.src);
      expect(image.status(), icon.src).toBe(200);
      expect(image.headers()['content-type'], icon.src).toBe('image/png');
      const { width, height } = pngSize(await image.body());
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  test('is still installable, and the manifest still loads, under the production policy', async ({
    app: { page },
  }) => {
    const policy = productionPolicy();
    expect(policy).toContain("manifest-src 'self'");
    await servePolicy(page, policy);
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });

    await signInPage(page);
    expect(await installabilityErrors(page)).toEqual([]);
    const manifest = await (await cdp(page)).send('Page.getAppManifest', {});
    expect(manifest.url).toMatch(/\/api\/manifest\.webmanifest$/);
    expect(manifest.errors).toEqual([]);
    expect(violations).toEqual([]);
  });

  test('a policy that forbids manifests is caught by the same check', async ({ app: { page } }) => {
    // The control for the test above: the policy really is applied, and the
    // manifest it blocks is noticed.
    await servePolicy(
      page,
      productionPolicy().replace("manifest-src 'self'", "manifest-src 'none'"),
    );
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/manifest-src/.test(message.text())) violations.push(message.text());
    });
    await signInPage(page);
    expect(await installabilityErrors(page)).toContain('no-manifest');
    expect(violations).not.toEqual([]);
  });

  test('there is no service worker and nothing is cached', async ({ app: { page } }) => {
    // Chromium accepts the app as installable without one (the first test
    // passes on a page that registers none), so none is added: nothing can
    // answer a request from a cache, and offline the browser's own error page
    // is all anyone sees.
    await signInPage(page);
    const state = await page.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      controlled: navigator.serviceWorker.controller !== null,
      caches: await caches.keys(),
    }));
    expect(state).toEqual({ registrations: 0, controlled: false, caches: [] });
  });

  test('offline, the browser shows its own error: no stale or empty shell is served', async ({
    app: { page, context },
  }) => {
    await signInPage(page);
    await context.setOffline(true);
    const failure = await page.goto('/auth/login').then(
      () => null,
      (error: Error) => error.message,
    );
    expect(failure).toMatch(/ERR_INTERNET_DISCONNECTED|net::ERR/);
    await context.setOffline(false);
  });
});
