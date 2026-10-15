// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { BRAND_SURFACES, brandThemeColor, COLOR_THEMES } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentBranding } from '../../src/components/brand/document-branding';
import { InstallAppSection } from '../../src/components/settings/install-app-section';
import { listenForInstallPrompt } from '../../src/lib/install-prompt';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsCustomizationPage } from '../../src/routes/settings/customization';
import { cleanup, renderAdmin, settle } from './admin-test-utils';

/**
 * The installable app (#400): the web side. The icons are real PNGs of the
 * sizes the manifest names, the maskable one keeps its mark inside the safe
 * zone, index.html carries the install metadata, DocumentBranding keeps it in
 * step with Branding, and the Install control exists only once the browser
 * has offered installing.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

/** A file of the web package, wherever vitest was started from. */
function webFile(relative: string): string {
  const path = [relative, `apps/web/${relative}`]
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Cannot find ${relative}`);
  return path;
}

/** An 8-bit, non-interlaced PNG decoded to rows of RGBA, with node's zlib alone. */
function decodePng(bytes: Buffer): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => number[];
} {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8);
  const colourType = bytes[25]!;
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  expect(channels, `colour type ${colourType}`).toBeGreaterThan(0);
  expect(bytes[28], 'not interlaced').toBe(0);

  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? (() => {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
                  })()
                : 0;
      line[i] = (line[i]! + predictor) & 0xff;
    }
    rows.push(line);
    previous = line;
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const row = rows[y]!;
      return [
        row[x * channels]!,
        row[x * channels + 1]!,
        row[x * channels + 2]!,
        channels === 4 ? row[x * channels + 3]! : 255,
      ];
    },
  };
}

describe('the bundled icons', () => {
  it.each([
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ])('%s is a PNG of %i px square', (file, size) => {
    const image = decodePng(readFileSync(webFile(`public/icons/${file}`)));
    expect([image.width, image.height]).toEqual([size, size]);
  });

  it('keeps the maskable mark inside the central 80% circle, on a full-bleed square', () => {
    const image = decodePng(readFileSync(webFile('public/icons/icon-maskable-512.png')));
    const centre = image.width / 2;
    const safeRadius = 0.4 * image.width;
    const tile = image.pixel(0, 0);
    expect(tile[3], 'the corner is opaque: nothing for a launcher to show through').toBe(255);
    let marked = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const pixel = image.pixel(x, y);
        const onTile = pixel.every((channel, index) => Math.abs(channel - tile[index]!) <= 2);
        if (onTile) continue;
        marked += 1;
        expect(
          Math.hypot(x + 0.5 - centre, y + 0.5 - centre),
          `pixel ${x},${y}`,
        ).toBeLessThanOrEqual(safeRadius);
      }
    }
    expect(marked, 'the mark is drawn').toBeGreaterThan(10_000);
  });

  it('leaves the corners of the plain icons transparent, as the favicon tile is rounded', () => {
    const image = decodePng(readFileSync(webFile('public/icons/icon-512.png')));
    expect(image.pixel(0, 0)[3]).toBe(0);
    expect(image.pixel(256, 256)[3]).toBe(255);
  });
});

/** OKLCH lightness of a neutral to sRGB hex, to compare tokens.css with the brand surfaces. */
function greyHex(lightnessPercent: number): string {
  const linear = (lightnessPercent / 100) ** 3;
  const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return `#${Math.round(encoded * 255)
    .toString(16)
    .padStart(2, '0')
    .repeat(3)}`;
}

describe('the brand surfaces', () => {
  const tokens = readFileSync(webFile('src/styles/tokens.css'), 'utf8');

  it('match --bg-root in tokens.css, so the splash screen is the page colour', () => {
    const dark = tokens.match(/:root,\s*\.dark \{[^}]*--bg-root:\s*oklch\(([\d.]+)% 0 0\)/)?.[1];
    const light = tokens.match(/\.light \{[^}]*--bg-root:\s*oklch\(([\d.]+)% 0 0\)/)?.[1];
    expect(dark).toBeTruthy();
    expect(light).toBeTruthy();
    expect(greyHex(Number(dark))).toBe(BRAND_SURFACES.dark);
    expect(greyHex(Number(light))).toBe(BRAND_SURFACES.light);
  });
});

describe('index.html', () => {
  const html = readFileSync(webFile('index.html'), 'utf8');

  it('links the manifest the instance serves', () => {
    expect(html).toMatch(/<link rel="manifest" href="\/api\/manifest\.webmanifest"/);
  });

  it('sets the theme colour and the Apple web-app tags', () => {
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}"/);
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="[^"]+"/);
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default"');
  });

  it('starts with the default dark neutral colour, the same as the manifest would give', () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${brandThemeColor('neutral', 'dark')}"`,
    );
  });
});

let root: Root | undefined;
let container: HTMLDivElement;

function status(branding: Record<string, unknown> = {}) {
  return {
    registrationMode: 'open',
    emailVerificationRequired: false,
    smtpConfigured: false,
    localAuthEnabled: true,
    ssoProviders: [],
    branding: {
      appName: 'Acme Research',
      shortName: null,
      logoUrl: null,
      loginMessage: null,
      colorTheme: 'violet',
      defaultTheme: 'dark',
      ...branding,
    },
  };
}

async function mountBranding() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactNode = (
    <QueryClientProvider client={client}>
      <DocumentBranding router={router} />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  await act(async () => root!.render(node));
  await settle();
}

const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;

function addInstallMeta() {
  document.head.innerHTML = `
    <meta name="theme-color" content="#0f0f0f" data-brand-theme-color />
    <meta name="apple-mobile-web-app-title" content="Open Chat I" data-brand-app-title />`;
}

describe('DocumentBranding keeps the install metadata in step with Branding', () => {
  beforeEach(() => {
    api.get.mockReset();
    addInstallMeta();
    document.documentElement.className = 'dark';
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    document.documentElement.className = '';
    document.head.innerHTML = '';
  });

  it('colours the browser with the accent of a hued theme', async () => {
    api.get.mockResolvedValue(status({ colorTheme: 'violet' }));
    await mountBranding();
    expect(meta('theme-color')).toBe(brandThemeColor('violet', 'dark'));
  });

  it.each(COLOR_THEMES)('uses the %s theme in the mode the page is in', async (theme) => {
    document.documentElement.className = 'light';
    api.get.mockResolvedValue(status({ colorTheme: theme }));
    await mountBranding();
    expect(meta('theme-color')).toBe(brandThemeColor(theme, 'light'));
  });

  it('follows the person switching between light and dark while the app runs', async () => {
    api.get.mockResolvedValue(status({ colorTheme: 'neutral' }));
    await mountBranding();
    expect(meta('theme-color')).toBe(BRAND_SURFACES.dark);
    await act(async () => {
      document.documentElement.className = 'light';
    });
    await settle();
    expect(meta('theme-color')).toBe(BRAND_SURFACES.light);
  });

  it('titles the home-screen icon with the short name, or the first 12 characters of the name', async () => {
    api.get.mockResolvedValue(
      status({ appName: 'Northwind University Research', shortName: 'NW Chat' }),
    );
    await mountBranding();
    expect(meta('apple-mobile-web-app-title')).toBe('NW Chat');
    await act(async () => root?.unmount());
    container.remove();
    api.get.mockResolvedValue(
      status({ appName: 'Northwind University Research', shortName: null }),
    );
    await mountBranding();
    expect(meta('apple-mobile-web-app-title')).toBe('Northwind Un');
  });

  it('leaves the served defaults alone until the status arrives', async () => {
    api.get.mockReturnValue(new Promise(() => {}));
    await mountBranding();
    expect(meta('theme-color')).toBe('#0f0f0f');
    expect(meta('apple-mobile-web-app-title')).toBe('Open Chat I');
  });
});

/** What Chromium fires when the app can be installed. */
function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe('the Install control', () => {
  let stopListening: () => void;
  beforeEach(() => {
    localStorage.clear();
    stopListening = listenForInstallPrompt();
    api.get.mockReset().mockImplementation(async (path: string) => {
      if (path === '/me')
        return {
          user: { id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user' },
          preferences: { displayName: null, occupation: null, traits: [], additionalContext: null },
          features: {},
        };
      throw new Error(`Unexpected GET ${path}`);
    });
  });
  afterEach(async () => {
    if (root) await cleanup(root);
    root = undefined;
    stopListening();
  });

  const installButton = () =>
    [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Install',
    );

  async function render(node: ReactNode) {
    ({ root } = await renderAdmin(<ThemeProvider>{node}</ThemeProvider>, {
      path: '/settings/customization',
    }));
  }

  it('is not on Settings → Customization until the browser offers installing', async () => {
    await render(<SettingsCustomizationPage />);
    expect(installButton()).toBeUndefined();
    expect(document.body.textContent).not.toMatch(/Install the app/);
  });

  it('appears once the browser fires beforeinstallprompt, even if that was before the page opened', async () => {
    const event = offerInstall();
    expect(event.defaultPrevented, 'the browser banner is held back for this control').toBe(true);
    await render(<SettingsCustomizationPage />);
    expect(document.body.textContent).toMatch(/Install the app/);
    expect(installButton()).toBeDefined();
  });

  it('appears while the page is open when the event arrives later', async () => {
    await render(<SettingsCustomizationPage />);
    expect(installButton()).toBeUndefined();
    offerInstall();
    await settle();
    expect(installButton()).toBeDefined();
  });

  it('asks the browser to install when pressed, and goes away: the event can be used once', async () => {
    const event = offerInstall('dismissed');
    await render(<InstallAppSection />);
    await act(async () => installButton()?.click());
    await settle();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(installButton()).toBeUndefined();
  });

  it('goes away when the app has been installed', async () => {
    offerInstall();
    await render(<InstallAppSection />);
    expect(installButton()).toBeDefined();
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    await settle();
    expect(installButton()).toBeUndefined();
  });

  it('stops listening when told to', async () => {
    stopListening();
    offerInstall();
    await render(<InstallAppSection />);
    expect(installButton()).toBeUndefined();
    stopListening = listenForInstallPrompt();
  });
});
