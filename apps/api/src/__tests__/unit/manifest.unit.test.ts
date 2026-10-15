import { deflateSync } from 'node:zlib';
import {
  BRAND_SURFACES,
  brandBackgroundColor,
  brandMode,
  brandThemeColor,
  COLOR_THEMES,
  DEFAULT_APP_NAME,
  DIAGRAM_ACCENTS,
} from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { installableLogoFromBytes } from '../../services/branding-assets.js';
import {
  BUNDLED_ICONS,
  buildManifest,
  MANIFEST_SHORT_NAME_MAX,
  type ManifestBranding,
} from '../../services/manifest.js';

/**
 * The web app manifest an instance serves (#400): built from Branding by a
 * pure function, so every combination is checked without a database.
 */

function branding(overrides: Partial<ManifestBranding> = {}): ManifestBranding {
  return {
    appName: 'Acme Research',
    shortName: null,
    colorTheme: 'neutral',
    defaultTheme: 'dark',
    ...overrides,
  };
}

/** A PNG with the given size in its header; the pixels are irrelevant here. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(8))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('the manifest builder', () => {
  it('names the app and fixes how it opens', () => {
    const manifest = buildManifest(branding(), { lang: 'en', logo: null });
    expect(manifest).toMatchObject({
      name: 'Acme Research',
      short_name: 'Acme Researc',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
    });
  });

  it('exposes only the listed fields', () => {
    const manifest = buildManifest(
      branding({ shortName: 'Acme', colorTheme: 'blue', defaultTheme: 'light' }),
      { lang: 'en', logo: { width: 512, height: 512 } },
    );
    expect(Object.keys(manifest).sort()).toEqual([
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
  });

  it('falls back to the product name when the name is blank', () => {
    const manifest = buildManifest(branding({ appName: '   ' }), { lang: 'en', logo: null });
    expect(manifest.name).toBe(DEFAULT_APP_NAME);
    expect(manifest.short_name).toBe(DEFAULT_APP_NAME.slice(0, MANIFEST_SHORT_NAME_MAX).trim());
  });

  describe('short name', () => {
    it('uses the configured short name', () => {
      expect(
        buildManifest(branding({ shortName: 'Acme' }), { lang: 'en', logo: null }).short_name,
      ).toBe('Acme');
    });

    it('falls back to the first 12 characters of the name when empty or blank', () => {
      for (const shortName of [null, '', '   ']) {
        const manifest = buildManifest(
          branding({ appName: 'University Research Assistant', shortName }),
          {
            lang: 'en',
            logo: null,
          },
        );
        expect(manifest.short_name).toBe('University R');
      }
    });

    it('is at most 12 characters even when configured longer', () => {
      const manifest = buildManifest(branding({ shortName: 'A very long short name' }), {
        lang: 'en',
        logo: null,
      });
      expect(Array.from(manifest.short_name).length).toBeLessThanOrEqual(12);
      expect(manifest.short_name).toBe('A very long');
    });

    it('does not split a character made of two code units', () => {
      const manifest = buildManifest(branding({ appName: '研究研究研究研究研究研究研究🙂🙂' }), {
        lang: 'en',
        logo: null,
      });
      expect(Array.from(manifest.short_name)).toHaveLength(12);
      expect(manifest.short_name).not.toMatch(/\ud83d$/);
    });

    it('keeps a long name whole', () => {
      const long = 'A'.repeat(200);
      expect(buildManifest(branding({ appName: long }), { lang: 'en', logo: null }).name).toBe(
        long,
      );
    });
  });

  describe('colours', () => {
    it.each(
      COLOR_THEMES.flatMap((theme) =>
        (['light', 'dark', 'system'] as const).map((mode) => [theme, mode]),
      ),
    )('%s theme, %s default: a hex colour each, the background follows the mode', (theme, mode) => {
      const manifest = buildManifest(branding({ colorTheme: theme, defaultTheme: mode }), {
        lang: 'en',
        logo: null,
      });
      expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
      expect(manifest.background_color).toBe(
        mode === 'light' ? BRAND_SURFACES.light : BRAND_SURFACES.dark,
      );
    });

    it('colours the title bar with the accent of a hued theme', () => {
      for (const theme of ['blue', 'violet', 'emerald'] as const) {
        expect(
          buildManifest(branding({ colorTheme: theme }), { lang: 'en', logo: null }).theme_color,
        ).toBe(DIAGRAM_ACCENTS[theme]);
      }
    });

    it('blends the title bar into the page for the neutral theme, which has no hue', () => {
      expect(brandThemeColor('neutral', 'dark')).toBe(BRAND_SURFACES.dark);
      expect(brandThemeColor('neutral', 'light')).toBe(BRAND_SURFACES.light);
    });

    it('treats an unknown theme as neutral and "system" as the dark start page', () => {
      expect(brandThemeColor('teal', 'dark')).toBe(BRAND_SURFACES.dark);
      expect(brandMode('system')).toBe('dark');
      expect(brandMode('light')).toBe('light');
      expect(brandMode(undefined)).toBe('dark');
      expect(brandBackgroundColor('light')).toBe('#ffffff');
    });
  });

  describe('icons', () => {
    const bundled = [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ];

    it('uses the bundled PNGs without a logo', () => {
      expect(BUNDLED_ICONS).toEqual(bundled);
      expect(buildManifest(branding(), { lang: 'en', logo: null }).icons).toEqual(bundled);
    });

    it('uses a square PNG logo of 512 px or more, at its own size', () => {
      const manifest = buildManifest(branding(), {
        lang: 'en',
        logo: { width: 1024, height: 1024 },
      });
      expect(manifest.icons).toEqual([
        { src: '/api/branding/logo', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
      ]);
    });

    it('accepts exactly 512', () => {
      expect(
        buildManifest(branding(), { lang: 'en', logo: { width: 512, height: 512 } }).icons[0],
      ).toMatchObject({
        src: '/api/branding/logo',
        sizes: '512x512',
      });
    });

    it('keeps the bundled icons for a logo the builder is told is too small or not square', () => {
      for (const logo of [
        { width: 511, height: 511 },
        { width: 512, height: 256 },
        { width: 1024, height: 512 },
      ]) {
        expect(buildManifest(branding(), { lang: 'en', logo }).icons).toEqual(bundled);
      }
    });

    it('only ever names same-origin icon URLs', () => {
      for (const logo of [null, { width: 600, height: 600 }]) {
        for (const icon of buildManifest(branding(), { lang: 'en', logo }).icons) {
          expect(icon.src).toMatch(/^\/[^/]/);
        }
      }
    });
  });
});

describe('what counts as an installable logo', () => {
  it('accepts a square PNG of 512 px or more and reports its size', () => {
    expect(installableLogoFromBytes(png(512, 512), 'image/png')).toEqual({
      width: 512,
      height: 512,
    });
    expect(installableLogoFromBytes(png(2048, 2048), 'image/png')).toEqual({
      width: 2048,
      height: 2048,
    });
  });

  it('refuses a PNG that is too small', () => {
    expect(installableLogoFromBytes(png(256, 256), 'image/png')).toBeNull();
    expect(installableLogoFromBytes(png(511, 511), 'image/png')).toBeNull();
  });

  it('refuses a PNG that is not square', () => {
    expect(installableLogoFromBytes(png(1024, 512), 'image/png')).toBeNull();
    expect(installableLogoFromBytes(png(512, 513), 'image/png')).toBeNull();
  });

  it('refuses every other type, and says PNG by the bytes rather than the stored label', () => {
    expect(installableLogoFromBytes(png(512, 512), 'image/jpeg')).toBeNull();
    expect(installableLogoFromBytes(png(512, 512), null)).toBeNull();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"/>');
    expect(installableLogoFromBytes(svg, 'image/svg+xml')).toBeNull();
    expect(installableLogoFromBytes(svg, 'image/png')).toBeNull();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
    expect(installableLogoFromBytes(jpeg, 'image/png')).toBeNull();
  });

  it('refuses a truncated or malformed PNG instead of throwing', () => {
    expect(installableLogoFromBytes(png(512, 512).subarray(0, 20), 'image/png')).toBeNull();
    expect(installableLogoFromBytes(Buffer.alloc(0), 'image/png')).toBeNull();
    const notIhdr = png(512, 512);
    notIhdr.write('IDAT', 12, 'ascii');
    expect(installableLogoFromBytes(notIhdr, 'image/png')).toBeNull();
  });
});
