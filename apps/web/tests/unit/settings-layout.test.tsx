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
let me: Record<string, unknown>;
beforeEach(() => {
  localStorage.clear();
  me = {
    user: { id: 'u1', name: 'Bitop Admin', email: 'admin@example.test', role: 'admin' },
  };
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return me;
    return { allowances: [] };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  localStorage.clear();
});

const tabLabels = () =>
  [...container.querySelectorAll('nav[aria-label="Settings sections"] a')].map(
    (link) => link.textContent,
  );

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
      'History',
      'Models',
      'Connectors',
      'Attachments',
    ]);
    expect(nav.className).toContain('flex-nowrap');
    expect(nav.className).not.toContain('flex-wrap ');
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('History');
  });

  it('offers one section menu instead of the tabs where they do not fit', async () => {
    await render();
    const nav = container.querySelector('nav[aria-label="Settings sections"]')!;
    const menu = container.querySelector('[aria-label="Settings section"]')!;
    // A container query swaps them at the same width, so exactly one shows.
    expect(nav.className).toContain('hidden');
    expect(nav.className).toContain('@[46rem]:inline-flex');
    expect(menu.closest('.\\@\\[46rem\\]\\:hidden')).not.toBeNull();
    expect(menu.textContent).toContain('History');
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

  it('hides Memory and Connectors when there is nothing in them for this person', async () => {
    me = {
      ...me,
      features: { memory: false },
      settingsSummary: { memoryEntries: 0, connectors: 0 },
    };
    await render();
    expect(tabLabels()).toEqual(['Account', 'Customization', 'History', 'Models', 'Attachments']);
    const menu = container.querySelector('[aria-label="Settings section"]')!;
    expect(menu.textContent).not.toContain('Memory');
  });

  it('keeps Memory while notes are saved, and Connectors while there is something to connect', async () => {
    me = {
      ...me,
      features: { memory: false },
      settingsSummary: { memoryEntries: 2, connectors: 1 },
    };
    await render();
    expect(tabLabels()).toContain('Memory');
    expect(tabLabels()).toContain('Connectors');
  });

  it('shows a hidden section while its address is open', async () => {
    me = {
      ...me,
      features: { memory: false },
      settingsSummary: { memoryEntries: 0, connectors: 0 },
    };
    await render('/settings/connectors');
    expect(tabLabels()).toContain('Connectors');
    expect(tabLabels()).not.toContain('Memory');
    const nav = container.querySelector('nav[aria-label="Settings sections"]')!;
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Connectors');
  });

  it('offers Light, Dark and System from the same menu as the chat', async () => {
    await render();
    expect(container.querySelector('button[aria-label="Toggle theme"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Appearance settings"]')).not.toBeNull();
  });

  it('shows the send and new-line keys the person has chosen', async () => {
    const row = (label: string) =>
      [...container.querySelectorAll('span')]
        .find((span) => span.textContent === label)
        ?.parentElement?.querySelectorAll('kbd');
    const keys = (label: string) => [...(row(label) ?? [])].map((kbd) => kbd.textContent);

    await render();
    expect(keys('Send Message')).toEqual(['Enter']);
    expect(keys('New Line')).toEqual(['⇧', 'Enter']);
    await cleanup(root!);

    localStorage.setItem('oci.invertSend', 'true');
    await render();
    expect(keys('Send Message')).toEqual(['⌘', 'Enter']);
    expect(keys('New Line')).toEqual(['Enter']);
  });

  it('keeps the wide-screen avatar at 96px', async () => {
    await render();
    const avatar = container.querySelector('.rounded-full.lg\\:size-24');
    expect(avatar?.textContent).toBe('BA');
    expect(container.querySelector('.lg\\:size-40')).toBeNull();
  });
});
