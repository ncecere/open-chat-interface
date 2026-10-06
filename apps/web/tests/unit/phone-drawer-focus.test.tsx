// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/layout/app-shell';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { button, cleanup, click, renderAdmin, settle } from './admin-test-utils';

/**
 * #191: on a phone, Shift+Tab from the sidebar drawer's first control left
 * the modal for "Skip to main content", then the browser. The real shell at
 * phone width; happy-dom has no Tab navigation of its own, so the key is
 * sent where focus is and the drawer must handle it as a modal does.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
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
  vi.unstubAllGlobals();
});

async function press(shiftKey: boolean) {
  const target = document.activeElement as HTMLElement;
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true });
    target.dispatchEvent(event);
  });
}

it('keeps Tab and Shift+Tab inside the open drawer', async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </ThemeProvider>,
    { path: '/chat/t1' },
  ));
  await click(button('Open sidebar'));
  await settle();
  const drawer = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
  expect(drawer.getAttribute('aria-label')).toBe('Conversation sidebar');
  const close = button('Close sidebar');
  expect(document.activeElement).toBe(close);

  // The skip link sits before the drawer and points at the page behind it.
  const skip = [...document.querySelectorAll('a')].find(
    (link) => link.textContent === 'Skip to main content',
  )!;
  expect(skip.hasAttribute('inert')).toBe(true);

  await press(true);
  const last = document.activeElement as HTMLElement;
  expect(drawer.contains(last), 'Shift+Tab stays in the drawer').toBe(true);
  expect(last).not.toBe(close);
  // The drawer's last control: nothing focusable follows it inside the drawer.
  const after = [...drawer.querySelectorAll<HTMLElement>('a[href], button, input')].filter(
    (element) =>
      last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !(element as HTMLButtonElement).disabled,
  );
  expect(after).toEqual([]);

  await press(false);
  expect(document.activeElement).toBe(close);
});

it('leaves the skip link alone while the drawer is closed', async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AppShell>
        <p>Page</p>
      </AppShell>
    </ThemeProvider>,
    { path: '/chat/t1' },
  ));
  const skip = [...document.querySelectorAll('a')].find(
    (link) => link.textContent === 'Skip to main content',
  )!;
  expect(skip.hasAttribute('inert')).toBe(false);
});
