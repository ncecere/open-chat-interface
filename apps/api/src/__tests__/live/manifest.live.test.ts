import { createDatabase } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { png } from '../../../test/png.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * The web app manifest (#400) through the real /api routes, real PostgreSQL
 * settings and real storage: public, typed, cached for five minutes, following
 * Branding, and never broken by a logo that cannot be used.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const available = await livePostgresAvailable();

interface Manifest {
  name: string;
  short_name: string;
  theme_color: string;
  background_color: string;
  lang: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
}

describe.skipIf(!available)('live: web app manifest', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let app: Hono<AppBindings>;
  let setBranding: (patch: Record<string, unknown>) => Promise<void>;
  let storeLogo: (bytes: Buffer) => Promise<string>;

  beforeAll(async () => {
    live = await createLiveDatabase('manifest');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    const { createApiRoutes } = await import('../../routes/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    const { updateSetting, invalidateSettingsCache } = await import('../../services/settings.js');
    const { storeInstanceLogo } = await import('../../services/branding-assets.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.route('/api', createApiRoutes());
    setBranding = async (patch) => {
      await updateSetting('branding', patch as never);
      invalidateSettingsCache();
    };
    storeLogo = async (bytes) =>
      (await storeInstanceLogo({ filename: 'logo.png', declaredMimeType: 'image/png', bytes }))
        .storageKey;
  });

  beforeEach(async () => {
    await setBranding({
      appName: 'Acme Research',
      shortName: null,
      logoUrl: null,
      logoMimeType: null,
      accentColor: null,
      loginMessage: null,
      defaultTheme: 'dark',
      colorTheme: 'neutral',
    });
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const get = () => app.request('/api/manifest.webmanifest');
  const manifest = async () => (await get()).json() as Promise<Manifest>;

  it('is public, typed and cacheable for five minutes', async () => {
    // No cookie, no authorization header: a browser fetches a manifest anonymously.
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toMatchObject({
      name: 'Acme Research',
      short_name: 'Acme Researc',
      start_url: '/',
      scope: '/',
      id: '/',
      display: 'standalone',
      lang: 'en',
    });
  });

  it('answers a HEAD request the same way', async () => {
    const response = await app.request('/api/manifest.webmanifest', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
  });

  it('serves the product name when branding is untouched', async () => {
    await setBranding({ appName: '' });
    expect((await manifest()).name).toBe('Open Chat Interface');
  });

  it('follows Branding after a settings change', async () => {
    await setBranding({
      appName: 'Northfield Chat',
      shortName: 'Northfield',
      colorTheme: 'violet',
      defaultTheme: 'light',
    });
    expect(await manifest()).toMatchObject({
      name: 'Northfield Chat',
      short_name: 'Northfield',
      theme_color: '#7f22fe',
      background_color: '#ffffff',
    });
    await setBranding({ colorTheme: 'neutral', defaultTheme: 'dark' });
    expect(await manifest()).toMatchObject({ theme_color: '#0f0f0f', background_color: '#0f0f0f' });
  });

  it('exposes nothing beyond name, colours and icon URLs', async () => {
    await setBranding({
      loginMessage: 'A private-looking sign-in message',
      accentColor: '#123456',
      logoMimeType: 'image/png',
    });
    const response = await get();
    const text = await response.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      'background_color',
      'display',
      'icons',
      'id',
      'lang',
      'name',
      'scope',
      'short_name',
      'start_url',
      'theme_color',
    ]);
    expect(text).not.toContain('private-looking');
    expect(text).not.toContain('#123456');
    expect(text).not.toContain('branding/');
  });

  describe('icons', () => {
    const bundled = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

    it('are the bundled PNGs without a logo', async () => {
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('are the uploaded logo when it is a square PNG of 512 px or more, and that URL serves a PNG', async () => {
      const key = await storeLogo(png(768, 768));
      await setBranding({ logoUrl: key, logoMimeType: 'image/png' });
      const { icons } = await manifest();
      expect(icons).toEqual([
        { src: '/api/branding/logo', sizes: '768x768', type: 'image/png', purpose: 'any' },
      ]);

      const logo = await app.request(icons[0]!.src);
      expect(logo.status).toBe(200);
      expect(logo.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await logo.arrayBuffer())).toEqual(png(768, 768));
    });

    it('stay the bundled PNGs for a logo that is too small', async () => {
      await setBranding({ logoUrl: await storeLogo(png(256, 256)), logoMimeType: 'image/png' });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('stay the bundled PNGs for a logo that is not square', async () => {
      await setBranding({ logoUrl: await storeLogo(png(1024, 512)), logoMimeType: 'image/png' });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('stay the bundled PNGs for a JPEG logo, however large', async () => {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
      const stored = await (await import('../../services/branding-assets.js')).storeInstanceLogo({
        filename: 'logo.jpg',
        declaredMimeType: 'image/jpeg',
        bytes: jpeg,
      });
      await setBranding({ logoUrl: stored.storageKey, logoMimeType: 'image/jpeg' });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('stay the bundled PNGs for an SVG logo, and an external logo address', async () => {
      await setBranding({
        logoUrl: 'branding/logo-00000000-0000-4000-8000-000000000000.svg',
        logoMimeType: 'image/svg+xml',
      });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
      await setBranding({
        logoUrl: 'https://cdn.example.test/mark-1024.png',
        logoMimeType: 'image/png',
      });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('stay the bundled PNGs, and the manifest is still served, when the logo cannot be read', async () => {
      // Stored as a PNG, but the object is gone (a restore without files, a storage outage).
      await setBranding({
        logoUrl: 'branding/logo-11111111-1111-4111-8111-111111111111.png',
        logoMimeType: 'image/png',
      });
      const response = await get();
      expect(response.status).toBe(200);
      expect(((await response.json()) as Manifest).icons.map((icon) => icon.src)).toEqual(bundled);
    });

    it('stay the bundled PNGs for a stored PNG label on bytes that are not a PNG', async () => {
      const driver = await (await import('../../services/storage/index.js')).getStorageDriver();
      const key = 'branding/logo-22222222-2222-4222-8222-222222222222.png';
      await driver.put(
        key,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>'),
        'image/png',
      );
      await setBranding({ logoUrl: key, logoMimeType: 'image/png' });
      expect((await manifest()).icons.map((icon) => icon.src)).toEqual(bundled);
    });
  });
});
