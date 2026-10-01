// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstanceThemeSync } from '../../src/providers/instance-theme-sync';
import { ThemeProvider, useTheme } from '../../src/providers/theme-provider';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
let container: HTMLDivElement;
let setTheme: ((theme: 'light' | 'dark' | 'system') => void) | undefined;

function ThemeProbe() {
  const theme = useTheme();
  setTheme = theme.setTheme;
  return <output data-theme={theme.theme} />;
}

function status(defaultTheme: 'light' | 'dark' | 'system') {
  return { branding: { colorTheme: 'blue', defaultTheme } };
}

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <InstanceThemeSync />
          <ThemeProbe />
        </ThemeProvider>
      </QueryClientProvider>,
    ),
  );
  for (let index = 0; index < 5; index += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const html = document.documentElement;
const probe = () => container.querySelector('output')?.getAttribute('data-theme');

beforeEach(() => {
  localStorage.clear();
  html.className = '';
  api.get.mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  root = undefined;
});

it('applies the instance default theme to someone who has not chosen one', async () => {
  api.get.mockResolvedValue(status('light'));
  await render();

  expect(api.get).toHaveBeenCalledWith('/auth/status');
  expect(probe()).toBe('light');
  expect(html.classList.contains('light')).toBe(true);
  expect(html.dataset.colorTheme).toBe('blue');
  // The default is cached for the next load, but never recorded as a choice.
  expect(localStorage.getItem('oci.instanceTheme')).toBe('light');
  expect(localStorage.getItem('oci.theme')).toBeNull();
});

it('keeps an explicit choice over the instance default', async () => {
  localStorage.setItem('oci.theme', 'dark');
  api.get.mockResolvedValue(status('light'));
  await render();

  expect(probe()).toBe('dark');
  expect(html.classList.contains('dark')).toBe(true);
});

it('lets a choice made after loading win over the default', async () => {
  api.get.mockResolvedValue(status('light'));
  await render();
  expect(probe()).toBe('light');

  await act(async () => setTheme?.('dark'));
  expect(probe()).toBe('dark');
  expect(localStorage.getItem('oci.theme')).toBe('dark');
});

it('starts from the cached default before the status request answers', async () => {
  localStorage.setItem('oci.instanceTheme', 'light');
  api.get.mockReturnValue(new Promise(() => {}));
  await render();

  expect(probe()).toBe('light');
});
