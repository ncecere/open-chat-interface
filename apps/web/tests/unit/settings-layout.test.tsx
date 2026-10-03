// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { cleanup, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
let container: HTMLElement;
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'u1', name: 'Bitop Admin', email: 'admin@example.test', role: 'admin' },
      };
    return { allowances: [] };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (path = '/settings/history') => {
  ({ root, container } = await renderAdmin(
    <ThemeProvider>
      <SettingsLayout />
    </ThemeProvider>,
    { path },
  ));
};

describe('settings layout', () => {
  it('has seven sections on one row that never wraps', async () => {
    await render();
    const nav = container.querySelector('nav[aria-label="Settings sections"]')!;
    const labels = [...nav.querySelectorAll('a')].map((link) => link.textContent);
    expect(labels).toEqual([
      'Account',
      'Customization',
      'Memory',
      'History & Sync',
      'Models',
      'Connectors',
      'Attachments',
    ]);
    expect(nav.className).toContain('flex-nowrap');
    expect(nav.className).not.toContain('flex-wrap ');
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('History & Sync');
  });

  it('offers one section menu instead of the tabs where they do not fit', async () => {
    await render();
    const nav = container.querySelector('nav[aria-label="Settings sections"]')!;
    const menu = container.querySelector('[aria-label="Settings section"]')!;
    // A container query swaps them at the same width, so exactly one shows.
    expect(nav.className).toContain('hidden');
    expect(nav.className).toContain('@[46rem]:inline-flex');
    expect(menu.closest('.\\@\\[46rem\\]\\:hidden')).not.toBeNull();
    expect(menu.textContent).toContain('History & Sync');
  });

  it('keeps shortcuts and help in cards instead of tabs of their own', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('Keyboard Shortcuts');
    expect(text).toContain('New Line');
    expect(text).toContain('Need help?');
    const nav = container.querySelector('nav[aria-label="Settings sections"]')!;
    expect(nav.textContent).not.toContain('Shortcuts');
    expect(nav.textContent).not.toContain('Contact');
  });

  it('places the side cards after the page on narrow screens and beside it on wide ones', async () => {
    await render();
    const grid = container.querySelector('nav[aria-label="Settings sections"]')!.closest('.grid')!;
    const [identity, page, cards] = [...grid.children];
    expect(identity?.textContent).toContain('Bitop Admin');
    expect(page?.querySelector('nav')).not.toBeNull();
    expect(cards?.textContent).toContain('Need help?');
    expect(cards?.className).toContain('lg:col-start-1');
    expect(page?.className).toContain('lg:col-start-2');
  });
});
