// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';

/** The pre-paint script from public/, run as the browser would. */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../public/theme-init.js'), 'utf8');
function run(prefersDark = true) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? prefersDark : !prefersDark,
  }));
  window.matchMedia = globalThis.matchMedia;
  new Function(source)();
  const root = document.documentElement;
  return {
    theme: root.classList.contains('light')
      ? 'light'
      : root.classList.contains('dark')
        ? 'dark'
        : 'none',
    color: root.dataset.colorTheme,
  };
}

beforeEach(() => {
  localStorage.clear();
  // As index.html starts.
  document.documentElement.className = 'dark';
  delete document.documentElement.dataset.colorTheme;
});

it("applies a person's stored light theme before the app loads", () => {
  localStorage.setItem('oci.theme', 'light');
  expect(run().theme).toBe('light');
});

it("follows the system for 'system', as the provider does", () => {
  localStorage.setItem('oci.theme', 'system');
  expect(run(false).theme).toBe('light');
  expect(run(true).theme).toBe('dark');
});

it('falls back to the instance default it last saw, then to dark', () => {
  localStorage.setItem('oci.instanceTheme', 'light');
  expect(run().theme).toBe('light');
  localStorage.clear();
  expect(run().theme).toBe('dark');
  localStorage.setItem('oci.theme', 'nonsense');
  expect(run().theme).toBe('dark');
});

it('applies the colour theme, ignoring unknown values', () => {
  localStorage.setItem('oci.colorTheme', 'violet');
  expect(run().color).toBe('violet');
  localStorage.setItem('oci.colorTheme', 'chartreuse');
  expect(run().color).toBe('neutral');
});
