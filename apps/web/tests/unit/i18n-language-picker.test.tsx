// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguagePicker } from '../../src/components/settings/language-picker';
import { I18nProvider } from '../../src/lib/i18n';
import { activateLocale } from '../../src/lib/i18n/state';
import { click, settle } from './admin-test-utils';
import { preloadCatalogs } from './i18n-test-utils';

// Settings → Customization → Language: saved to the server, applied at once,
// beta languages labelled, nothing shown when there is no choice to make.

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

let root: Root | undefined;
let container: HTMLElement;
let stored: string | null;

function server(options: { enabled: string[]; saved?: string | null; patchFails?: boolean }) {
  stored = options.saved ?? null;
  api.get.mockImplementation(async (path: string) => {
    if (path === '/auth/status')
      return { branding: {}, language: { default: null, enabled: options.enabled } };
    if (path === '/me') return { user: { id: 'u' }, preferences: { locale: stored }, features: {} };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockImplementation(async (_path: string, body: { locale: string | null }) => {
    if (options.patchFails) throw new Error('boom');
    stored = body.locale;
    return { preferences: { locale: stored } };
  });
}

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <LanguagePicker />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const trigger = () => container.querySelector<HTMLElement>('button[role="combobox"]');
const optionLabels = () =>
  [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);

async function choose(label: string) {
  await click(trigger()!);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`No option ${label}: ${optionLabels().join(' | ')}`);
  await click(option);
}

beforeAll(preloadCatalogs);
beforeEach(async () => {
  localStorage.clear();
  api.get.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
  await activateLocale('en');
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  document.body.innerHTML = '';
});

describe('the language picker', () => {
  it('lists the enabled languages in their own language, beta ones labelled', async () => {
    server({ enabled: ['en', 'es', 'ar'] });
    await mount();
    expect(container.querySelector('h2')?.textContent).toBe('Language');
    await click(trigger()!);
    expect(optionLabels()).toEqual([
      'Automatic',
      'English',
      'Español (beta)',
      'العربية (beta)',
      // Pseudo-locales exist outside production builds, and are never saved.
      'Pseudo-locale: accented, longer',
      'Pseudo-locale: forced right-to-left',
    ]);
  });

  it('shows only what the instance enabled', async () => {
    server({ enabled: ['en', 'es'] });
    await mount();
    await click(trigger()!);
    expect(optionLabels().slice(0, 3)).toEqual(['Automatic', 'English', 'Español (beta)']);
    expect(optionLabels()).not.toContain('العربية (beta)');
  });

  it('saves to the server and applies at once, then says so', async () => {
    server({ enabled: ['en', 'es'] });
    await mount();
    await choose('Español (beta)');
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', { locale: 'es' });
    expect(document.documentElement.lang).toBe('es');
    // The page itself is now Spanish, with the machine-draft notice.
    expect(container.querySelector('h2')?.textContent).toBe('Idioma');
    expect(container.textContent).toContain('borrador automático');
    expect(toast.success).toHaveBeenCalledWith('Idioma guardado.');
    expect(localStorage.getItem('oci.locale')).toBe('es');
  });

  it('turns the page right-to-left for Arabic', async () => {
    server({ enabled: ['en', 'ar'] });
    await mount();
    await choose('العربية (beta)');
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', { locale: 'ar' });
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('shows the saved language on load, and Automatic clears it', async () => {
    server({ enabled: ['en', 'es'], saved: 'es' });
    await mount();
    expect(document.documentElement.lang).toBe('es');
    expect(trigger()?.textContent).toBe('Español (beta)');
    await choose('Automático');
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', { locale: null });
    expect(stored).toBeNull();
  });

  it('does not save when the same language is chosen again', async () => {
    server({ enabled: ['en', 'es'], saved: 'es' });
    await mount();
    await choose('Español (beta)');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('keeps the language and says so when saving fails', async () => {
    server({ enabled: ['en', 'es'], patchFails: true });
    await mount();
    await choose('Español (beta)');
    expect(document.documentElement.lang).toBe('en');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Your language could not be saved. Try again.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows Automatic for a person whose language was switched off, and keeps what was saved', async () => {
    server({ enabled: ['en', 'es'], saved: 'ar' });
    await mount();
    expect(document.documentElement.lang).toBe('en');
    expect(trigger()?.textContent).toBe('Automatic');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('applies a pseudo-locale on this device without saving it', async () => {
    server({ enabled: ['en'] });
    await mount();
    await choose('Pseudo-locale: forced right-to-left');
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe('ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('oci.pseudoLocale')).toBe('ar-XB');
  });
});

describe('without a choice to make', () => {
  it('renders nothing outside the provider (English only, as in a production build)', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient();
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <LanguagePicker />
        </QueryClientProvider>,
      ),
    );
    expect(container.innerHTML).toBe('');
  });
});
