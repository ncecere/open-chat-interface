// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/layout/app-shell';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { cleanup, renderAdmin, settle } from './admin-test-utils';

/**
 * Every way to New Chat gives an ordinary chat (#340): the top bar's "+" and
 * the shortcut left temporary mode, the sidebar button and the command palette
 * kept it, so work started there was deleted after 24 hours. The real shell,
 * provider and sessionStorage are used.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const KEY = 'oci.temporaryChat';
let root: Root | undefined;
beforeEach(() => {
  sessionStorage.setItem(KEY, 'true');
  // Control is the modifier on this platform.
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Linux x86_64' });
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function openShell() {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </ThemeProvider>,
    { path: '/chat/t1' },
  ));
}

it("the sidebar's New Chat button leaves temporary mode", async () => {
  await openShell();
  expect(sessionStorage.getItem(KEY)).toBe('true');
  const button = [...document.querySelectorAll('aside button')].find(
    (candidate) => candidate.textContent?.trim() === 'New Chat',
  ) as HTMLButtonElement;
  await act(async () => button.click());
  await settle();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

/** On the document, as a key press is; the modifier is the platform's. */
async function press(key: string, init: KeyboardEventInit) {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

it("the top bar's + leaves temporary mode (unchanged)", async () => {
  await openShell();
  // The "+" is in the top bar while the sidebar is closed.
  const close = document.querySelector('aside button[aria-label="Close sidebar"]');
  await act(async () => (close as HTMLButtonElement).click());
  await settle();
  const plus = document.querySelector('header a[aria-label="New chat"]') as HTMLAnchorElement;
  await act(async () => plus.click());
  await settle();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('the shortcut leaves temporary mode (unchanged)', async () => {
  await openShell();
  await press('O', { shiftKey: true, ctrlKey: true });
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it("the command palette's New chat leaves temporary mode", async () => {
  await openShell();
  await press('k', { ctrlKey: true });
  const item = [...document.querySelectorAll('[role="option"]')].find((candidate) =>
    candidate.textContent?.includes('New chat'),
  ) as HTMLElement;
  expect(item).toBeDefined();
  await act(async () => item.click());
  await settle();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});
