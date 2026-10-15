// @vitest-environment happy-dom

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useT } from '../../src/lib/i18n';
import { activateLocale, getI18nState, initialLocale, translate } from '../../src/lib/i18n/state';
import { LOCALES } from '../../src/locales';
import { settle } from './admin-test-utils';

// Every catalog, English included, is a dynamic import the app awaits before
// its first render (v0.14, #397 step 2a), so ~1,000 strings stay out of the
// initial JavaScript. These tests are what keeps that true, and what keeps
// every other test able to read English without awaiting anything.

const REGISTRY = '__ociI18nCatalogs';
const registry = globalThis as unknown as Record<string, unknown>;

/** A fresh copy of the state module with nothing loaded, as at the page's first load. */
async function coldState() {
  delete registry[REGISTRY];
  vi.resetModules();
  return import('../../src/lib/i18n/state');
}

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const originalLoaders = { en: LOCALES.en.load, es: LOCALES.es.load, ar: LOCALES.ar.load };
beforeEach(() => localStorage.clear());
afterEach(async () => {
  Object.assign(LOCALES.en, { load: originalLoaders.en });
  Object.assign(LOCALES.es, { load: originalLoaders.es });
  Object.assign(LOCALES.ar, { load: originalLoaders.ar });
  vi.restoreAllMocks();
  // Leave the next test file's world as the setup file made it.
  await activateLocale('en');
});

describe('the unit test setup', () => {
  it('has English active before a test starts, so useT() reads real strings with no await', async () => {
    expect(getI18nState().ready).toBe(true);
    expect(translate('settings.language.title')).toBe('Language');
    let text = '';
    function Probe() {
      text = useT()('settings.language.title');
      return null;
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    expect(text).toBe('Language');
    await act(async () => root.unmount());
  });

  it('survives vi.resetModules(): a re-evaluated state module finds the catalogs already loaded', async () => {
    vi.resetModules();
    const fresh = await import('../../src/lib/i18n/state');
    expect(fresh.getI18nState().ready).toBe(true);
    expect(fresh.translate('settings.language.title')).toBe('Language');
  });
});

describe('a cold start', () => {
  it('has no strings until a catalog is loaded: keys, not a throw', async () => {
    const cold = await coldState();
    expect(cold.getI18nState().ready).toBe(false);
    expect(cold.translate('settings.language.title')).toBe('settings.language.title');
    await cold.activateLocale('en');
    expect(cold.getI18nState().ready).toBe(true);
    expect(cold.translate('settings.language.title')).toBe('Language');
  });

  it('loads English next to another language, as the fallback for a key it lacks', async () => {
    const cold = await coldState();
    await cold.activateLocale('es');
    expect(cold.getI18nState().locale).toBe('es');
    expect(cold.translate('settings.language.title')).toBe('Idioma');
    // English is in memory too: a non-English start can still fall back.
    const { LOCALES: fresh } = await import('../../src/locales');
    const load = vi.spyOn(fresh.en, 'load');
    await cold.activateLocale('en');
    expect(load).not.toHaveBeenCalled();
    expect(cold.translate('settings.language.title')).toBe('Language');
  });

  it('fetches each catalog once, however often it is activated', async () => {
    const cold = await coldState();
    const { LOCALES: fresh } = await import('../../src/locales');
    const load = vi.spyOn(fresh.es, 'load');
    await cold.activateLocale('es');
    await cold.activateLocale('en');
    await cold.activateLocale('es');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls back to English when the first language cannot be fetched, and says <html lang> is English', async () => {
    const cold = await coldState();
    const { LOCALES: fresh } = await import('../../src/locales');
    fresh.ar.load = () => Promise.reject(new Error('offline'));
    await expect(cold.activateLocale('ar')).resolves.toBeUndefined();
    expect(cold.getI18nState()).toMatchObject({ locale: 'en', dir: 'ltr', ready: true });
    expect(cold.translate('settings.language.title')).toBe('Language');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('shows the key, without throwing, when even English cannot be fetched, and is ready all the same', async () => {
    const cold = await coldState();
    const { LOCALES: fresh } = await import('../../src/locales');
    fresh.en.load = () => Promise.reject(new Error('offline'));
    fresh.es.load = () => Promise.reject(new Error('offline'));
    await expect(cold.activateLocale('es')).resolves.toBeUndefined();
    expect(cold.getI18nState()).toMatchObject({ locale: 'en', ready: true });
    expect(cold.translate('settings.language.title')).toBe('settings.language.title');
    expect(cold.translate('language.optionBeta', { name: 'x' })).toBe('language.optionBeta');
  });

  it('keeps the language already showing when a later switch cannot be fetched', async () => {
    const cold = await coldState();
    const { LOCALES: fresh } = await import('../../src/locales');
    await cold.activateLocale('es');
    fresh.ar.load = () => Promise.reject(new Error('stale chunk'));
    await cold.activateLocale('ar');
    expect(cold.getI18nState().locale).toBe('es');
    expect(cold.translate('settings.language.title')).toBe('Idioma');
    expect(document.documentElement.lang).toBe('es');
  });

  it('builds a pseudo-locale from the lazily loaded English', async () => {
    const cold = await coldState();
    await cold.activateLocale('en-XA');
    expect(cold.getI18nState().locale).toBe('en-XA');
    expect(cold.translate('settings.language.title')).toMatch(/^\[.*\]$/);
    expect(cold.translate('settings.language.title')).not.toBe('Language');
  });

  it('starts from what was shown last time on this device', async () => {
    expect(initialLocale({ pseudo: false })).toBe('en');
    localStorage.setItem('oci.locale', 'ar');
    expect(initialLocale({ pseudo: false })).toBe('ar');
  });
});

describe('I18nProvider before the first catalog', () => {
  let root: Root;
  let container: HTMLElement;
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  it('renders nothing, not bare keys, until the catalog is loaded, then the app in the language', async () => {
    localStorage.setItem('oci.locale', 'es');
    const cold = await coldState();
    const { I18nProvider: Provider, useT: useColdT } = await import('../../src/lib/i18n');
    api.get.mockImplementation(async (path: string) => {
      if (path === '/auth/status')
        return { branding: {}, language: { default: null, enabled: ['en', 'es'] } };
      if (path === '/me') return { user: { id: 'u' }, preferences: { locale: 'es' }, features: {} };
      throw new Error(`Unexpected GET ${path}`);
    });
    const seen: string[] = [];
    function Probe() {
      const t = useColdT();
      seen.push(t('settings.language.title'));
      return <p data-testid="probe">{t('settings.language.title')}</p>;
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Provider>
            <Probe />
          </Provider>
        </QueryClientProvider>,
      ),
    );
    // Nothing painted before the load finished...
    await settle();
    expect(container.querySelector('[data-testid=probe]')?.textContent).toBe('Idioma');
    // ...and never a key or the wrong language in between.
    expect(seen.every((text) => text === 'Idioma')).toBe(true);
    expect(cold.getI18nState().ready).toBe(true);
  });

  it('still shows the app when no catalog can be fetched at all (keys, never a blank page)', async () => {
    const cold = await coldState();
    const { LOCALES: fresh } = await import('../../src/locales');
    fresh.en.load = () => Promise.reject(new Error('offline'));
    const { I18nProvider: Provider } = await import('../../src/lib/i18n');
    api.get.mockRejectedValue(new Error('down'));
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Provider>
            <p data-testid="app">app</p>
          </Provider>
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(container.querySelector('[data-testid=app]')).not.toBeNull();
    expect(cold.getI18nState().ready).toBe(true);
  });
});

describe('what ends up in the initial JavaScript', () => {
  const src = join(import.meta.dirname, '../../src');
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('has no value import of a catalog anywhere in src: only `import type` and dynamic import()', () => {
    const offenders = sources(src).filter((file) =>
      /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*locales\/[a-zA-Z-]+\.json['"]/m.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
