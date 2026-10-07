// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/layout/app-shell';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { cleanup, renderAdmin, settle } from './admin-test-utils';
import { styleFor, toPx } from './css-test-utils';

/**
 * #166: the top bar's floating controls hid a conversation's first lines;
 * #167: the announcement banner moved the page after it had painted.
 * The real shell is rendered; its classes are compiled by the project's
 * Tailwind to place the controls and the start of the scrolling page.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'me', name: 'Pat', email: 'pat@example.test', role: 'user' },
        preferences: {},
        features: { temporaryChat: true, projects: false, shareLinks: false },
      };
    if (path === '/me/broadcasts') return { broadcasts: [] };
    if (path === '/maintenance') return { active: false };
    return { threads: [], projects: [], branding: {} };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.unstubAllGlobals();
});

function viewport(desktop: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: desktop,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

/** States from the element itself, for variants such as `empty:`. */
const statesOf = (element: Element) => (element.childElementCount === 0 ? [':empty' as const] : []);

/** Where an element's box ends below its offset parent, from its compiled classes. */
async function controlsBottom(controls: HTMLElement): Promise<number> {
  const style = await styleFor(controls.className);
  const buttons = await Promise.all(
    [...controls.querySelectorAll('button, a')].map(async (button) =>
      toPx((await styleFor(button.className)).height),
    ),
  );
  return (
    toPx(style.top) +
    2 * toPx(style.padding) +
    2 * toPx(style['border-width']) +
    Math.max(0, ...buttons)
  );
}

it.each([
  ['a phone (sidebar closed)', false],
  ['a desktop (sidebar open)', true],
])('starts the scrolling page below the floating controls on %s', async (_, desktop) => {
  viewport(desktop);
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AppShell>
        <p>First line of the conversation</p>
      </AppShell>
    </ThemeProvider>,
    { path: '/chat/t1' },
  ));

  const header = document.querySelector('header')!;
  const main = document.querySelector('main')!;
  const scroller = document.getElementById('main-content')!;
  const strip = scroller.previousElementSibling;
  // Nothing between the header and the scroller but a strip inside the panel.
  expect(strip?.parentElement).toBe(main);
  expect(main.previousElementSibling).toBe(header);

  const headerHeight = toPx((await styleFor(header.className)).height);
  const stripStyle = await styleFor(strip!.className, statesOf(strip!));
  expect(stripStyle.display, 'the strip is laid out with no banner').not.toBe('none');
  const pageTop = headerHeight + toPx(stripStyle['padding-top']);

  const controls = [...header.querySelectorAll<HTMLElement>('[data-floating-controls]')];
  expect(controls.length).toBe(desktop ? 1 : 2);
  for (const group of controls) {
    expect(pageTop).toBeGreaterThanOrEqual(await controlsBottom(group));
  }
});

/**
 * #167: the announcement banner arrived after the page had painted and
 * pushed it down (CLS 0.08-0.13). The page is laid out hidden until the
 * first answer about announcements, then shown with the banner in place.
 */
it('shows the page only once announcements are known, so a banner does not move it', async () => {
  viewport(true);
  let answer!: (value: unknown) => void;
  const fallback = api.get.getMockImplementation()!;
  api.get.mockImplementation((path: string) =>
    path === '/me/broadcasts'
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : fallback(path),
  );
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </ThemeProvider>,
    { path: '/' },
  ));
  const scroller = document.getElementById('main-content')!;
  const visibility = async () => (await styleFor(scroller.className)).visibility ?? 'visible';
  expect(await visibility()).toBe('hidden');
  expect(scroller.getAttribute('aria-busy')).toBe('true');

  await act(async () =>
    answer({
      broadcasts: [
        {
          id: 'b1',
          title: 'Maintenance on Sunday',
          body: 'Read-only from 06:00.',
          level: 'warning',
          dismissable: true,
        },
      ],
    }),
  );
  await settle();
  expect(document.querySelector('[data-banners]')?.textContent).toContain('Maintenance on Sunday');
  expect(await visibility()).toBe('visible');
  expect(scroller.getAttribute('aria-busy')).toBe('false');
});
