// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLOR_THEMES, DIAGRAM_ACCENTS } from '@oci/shared';
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
import { compactLabel, Wordmark } from '../../src/components/brand/wordmark';
import {
  applyBrandIcons,
  brandIconHref,
  documentTitle,
  pageTitleFor,
  usePageTitle,
} from '../../src/lib/document-title';
import { PublicSharePage } from '../../src/routes/share/public-share';

/** Branding applied everywhere (v0.10): mark, tab title and icon, share header, diagram accents. */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

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

let root: Root | undefined;
let container: HTMLDivElement;

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  );
  await settle();
}

/** The icon links index.html serves. */
function addDefaultIcons() {
  document.head.innerHTML = `
    <link rel="icon" href="/favicon.ico" sizes="32x32" data-brand-icon />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" data-brand-icon />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" data-brand-icon />`;
}

const icons = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[data-brand-icon]')].map((link) => ({
    href: link.getAttribute('href'),
    type: link.getAttribute('type'),
    sizes: link.getAttribute('sizes'),
  }));

beforeEach(() => {
  api.get.mockReset();
  addDefaultIcons();
  document.title = 'Open Chat Interface';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

describe('wordmark', () => {
  it('shows the Turns mark beside the name as live text when there is no logo', async () => {
    await mount(<Wordmark name="Acme Research" />);
    const mark = container.querySelector('[data-wordmark="mark"]')!;
    expect(mark.textContent).toBe('Acme Research');
    const svg = mark.querySelector('svg[data-brand-mark="turns"]')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    // The mark's colours are fixed, never the instance accent.
    expect(svg.innerHTML).toContain('#171717');
    expect(svg.innerHTML).toContain('#51a2ff');
  });

  it('names the product when no name is configured', async () => {
    await mount(<Wordmark name="  " compact />);
    expect(container.textContent).toBe('Open Chat Interface');
  });

  it('shows an uploaded logo instead of the mark, named for assistive technology', async () => {
    await mount(<Wordmark name="Acme Research" logoUrl="/api/branding/logo" compact />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/branding/logo');
    expect(image.getAttribute('alt')).toBe('Acme Research');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('uses the short name, the full name, or initials in the compact header', () => {
    expect(compactLabel('Acme Research', 'ACME')).toBe('ACME');
    expect(compactLabel('Open Chat Interface', null)).toBe('Open Chat Interface');
    expect(compactLabel('Northwind University Research Assistant', '  ')).toBe('NURA');
    // Two words have no useful initials, so the header truncates the name instead.
    expect(compactLabel('Supercalifragilistic Assistant', null)).toBe(
      'Supercalifragilistic Assistant',
    );
  });
});

describe('tab title', () => {
  it('names the page, then the instance', () => {
    expect(documentTitle(pageTitleFor('/auth/login'), 'Acme')).toBe('Sign in · Acme');
    expect(documentTitle(pageTitleFor('/auth/reset-password'), 'Acme')).toBe(
      'Reset password · Acme',
    );
    expect(documentTitle(pageTitleFor('/settings/memory/'), 'Acme')).toBe('Settings · Acme');
    expect(documentTitle(pageTitleFor('/admin/branding'), 'Acme')).toBe('Branding · Admin · Acme');
    expect(documentTitle(pageTitleFor('/admin/users/u-1'), 'Acme')).toBe('Users · Admin · Acme');
    expect(documentTitle(pageTitleFor('/admin'), 'Acme')).toBe('Overview · Admin · Acme');
    expect(documentTitle(pageTitleFor('/share/abc'), 'Acme')).toBe('Shared conversation · Acme');
  });

  it('is the instance name alone on chat pages, or the product name without one', () => {
    expect(pageTitleFor('/')).toBeNull();
    expect(pageTitleFor('/chat/t-1')).toBeNull();
    expect(documentTitle(null, 'Acme')).toBe('Acme');
    expect(documentTitle(' ', undefined)).toBe('Open Chat Interface');
    expect(pageTitleFor('/administrator')).toBeNull();
  });
});

describe('tab icon', () => {
  it('uses only a same-origin logo', () => {
    expect(brandIconHref('/api/branding/logo')).toBe('/api/branding/logo');
    expect(brandIconHref('https://cdn.example.com/logo.png')).toBeNull();
    expect(brandIconHref('//cdn.example.com/logo.png')).toBeNull();
    expect(brandIconHref(null)).toBeNull();
    expect(brandIconHref(' ')).toBeNull();
  });

  it('points every icon at the logo and restores the defaults', () => {
    const defaults = icons();
    applyBrandIcons('/api/branding/logo');
    expect(icons()).toEqual(
      defaults.map(() => ({ href: '/api/branding/logo', type: null, sizes: null })),
    );
    applyBrandIcons(null);
    expect(icons()).toEqual(defaults);
  });
});

function TitledPage({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

async function mountRouted(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = (routePath: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page('/'),
      page('/auth/login'),
      page('/admin/branding'),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/share/$slug',
        component: () => <TitledPage title="Quarterly plan" />,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    await router.load();
  });
  await mount(
    <>
      <DocumentBranding router={router} />
      <RouterProvider router={router} />
    </>,
  );
  return router;
}

describe('document branding', () => {
  it('follows the instance name and the route', async () => {
    api.get.mockResolvedValue(status());
    const router = await mountRouted('/auth/login');
    expect(api.get).toHaveBeenCalledWith('/auth/status');
    expect(document.title).toBe('Sign in · Acme Research');

    await act(async () => {
      await router.navigate({ to: '/admin/branding' });
    });
    await settle();
    expect(document.title).toBe('Branding · Admin · Acme Research');

    await act(async () => {
      await router.navigate({ to: '/' });
    });
    await settle();
    expect(document.title).toBe('Acme Research');
    // No logo: the Turns icons stay.
    expect(icons()[1]).toEqual({ href: '/favicon.svg', type: 'image/svg+xml', sizes: null });
  });

  it('lets a page name itself, and uses an uploaded logo as the tab icon', async () => {
    api.get.mockResolvedValue(status({ logoUrl: '/api/branding/logo' }));
    await mountRouted('/share/abc');
    expect(document.title).toBe('Quarterly plan · Acme Research');
    expect(icons().map((icon) => icon.href)).toEqual([
      '/api/branding/logo',
      '/api/branding/logo',
      '/api/branding/logo',
    ]);
  });
});

describe('public share page', () => {
  it("carries the instance's name in the header and the conversation's title in the tab", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/auth/status') return status({ shortName: 'ACME' });
      return {
        thread: { title: 'Quarterly plan', sharedAt: '2026-10-01T12:00:00.000Z' },
        messages: [],
        snapshot: true,
        expiresAt: null,
      };
    });
    await mount(<PublicSharePage slug="abc" />);
    const header = container.querySelector('header')!;
    expect(header.querySelector('[data-wordmark="mark"]')?.textContent).toBe('ACME');
    expect(header.querySelector('[data-wordmark="mark"]')?.getAttribute('title')).toBe(
      'Acme Research',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Quarterly plan');
  });

  it('shows an uploaded logo in the header', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/auth/status'
        ? status({ logoUrl: '/api/branding/logo' })
        : {
            thread: { title: 'Plan', sharedAt: '2026-10-01T12:00:00.000Z' },
            messages: [],
            snapshot: false,
            expiresAt: null,
          },
    );
    await mount(<PublicSharePage slug="abc" />);
    const logo = container.querySelector('header img')!;
    expect(logo.getAttribute('src')).toBe('/api/branding/logo');
    expect(logo.getAttribute('alt')).toBe('Acme Research');
  });
});

/** OKLCH to sRGB hex (CSS Color 4), to compare tokens.css with the diagram accents. */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const L = lightness / 100;
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((value) => {
      const clamped = Math.min(1, Math.max(0, value));
      const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

describe('diagram accents', () => {
  // happy-dom's import.meta.url is not a file URL, and Vite's CSS handling
  // empties a ?raw stylesheet import, so read it from the package directory.
  const path = ['src/styles/tokens.css', 'apps/web/src/styles/tokens.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  const tokens = readFileSync(path ?? 'src/styles/tokens.css', 'utf8');

  it.each(COLOR_THEMES.filter((theme) => theme !== 'neutral'))(
    "match the %s theme's light-mode accent in tokens.css",
    (theme) => {
      const block = tokens.match(
        new RegExp(`\\[data-color-theme="${theme}"\\]\\.light \\{([^}]*)\\}`),
      )?.[1];
      const accent = block?.match(/--accent:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/);
      expect(accent, `${theme} light --accent`).toBeTruthy();
      const [, lightness, chroma, hue] = accent!.map(Number);
      expect(oklchToHex(lightness!, chroma!, hue!)).toBe(DIAGRAM_ACCENTS[theme]);
    },
  );

  it("keeps Diagram Design's orange for neutral, whose accent has no hue", () => {
    expect(DIAGRAM_ACCENTS.neutral).toBe('#eb6c36');
    expect(tokens).toMatch(
      /\[data-color-theme="neutral"\]\.light \{\s*--accent: oklch\([\d.]+% 0 0\)/,
    );
  });
});
