// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useLocale, useT } from '../../src/lib/i18n';
import { activateLocale } from '../../src/lib/i18n/state';
import { settle } from './admin-test-utils';
import { preloadCatalogs } from './i18n-test-utils';

// The provider decides the language from the person's saved choice, the
// instance setting and the browser, and keeps <html lang dir> in step.

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function Probe() {
  const t = useT();
  const { locale, dir, available } = useLocale();
  return (
    <p data-testid="probe">
      {t('settings.language.title')}|{locale}|{dir}|{available.join(',')}
    </p>
  );
}

let root: Root | undefined;
let container: HTMLElement;

function respond(options: {
  saved?: string | null;
  signedIn?: boolean;
  language?: { default: string | null; enabled: string[] };
  statusFails?: boolean;
}) {
  const { saved = null, signedIn = true, language, statusFails = false } = options;
  api.get.mockImplementation(async (path: string) => {
    if (path === '/auth/status') {
      if (statusFails) throw new Error('down');
      return { branding: {}, ...(language && { language }) };
    }
    if (path === '/me') {
      if (!signedIn) {
        const { ApiError } = await import('../../src/lib/api-client');
        throw new ApiError(401, 'unauthorized', 'No');
      }
      return { user: { id: 'u' }, preferences: { locale: saved }, features: {} };
    }
    throw new Error(`Unexpected GET ${path}`);
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
          <Probe />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container.querySelector('[data-testid=probe]')?.textContent;
}

function browserLanguages(languages: string[]) {
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
}

beforeAll(preloadCatalogs);
beforeEach(async () => {
  localStorage.clear();
  api.get.mockReset();
  browserLanguages(['en-US']);
  await activateLocale('en');
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

describe('I18nProvider', () => {
  it('shows English when the instance enables nothing else', async () => {
    respond({ language: { default: null, enabled: ['en'] } });
    expect(await mount()).toBe('Language|en|ltr|en,en-XA,ar-XB');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it("uses the person's saved language and sets <html lang dir>", async () => {
    respond({ saved: 'es', language: { default: 'en', enabled: ['en', 'es', 'ar'] } });
    expect(await mount()).toBe('Idioma|es|ltr|en,es,ar,en-XA,ar-XB');
    expect(document.documentElement.lang).toBe('es');
  });

  it('turns the page right-to-left for Arabic', async () => {
    respond({ saved: 'ar', language: { default: null, enabled: ['en', 'ar'] } });
    expect(await mount()).toContain('|ar|rtl|');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('uses the instance default for a person who has not chosen', async () => {
    respond({ saved: null, language: { default: 'es', enabled: ['en', 'es'] } });
    expect(await mount()).toContain('Idioma|es|');
  });

  it('follows the browser when there is no choice and no default, for an enabled language only', async () => {
    browserLanguages(['ar-EG', 'es-MX']);
    respond({ language: { default: null, enabled: ['en', 'es'] } });
    expect(await mount()).toContain('Idioma|es|');
  });

  it('falls back without error when the saved language is no longer enabled', async () => {
    respond({ saved: 'ar', language: { default: 'es', enabled: ['en', 'es'] } });
    expect(await mount()).toContain('Idioma|es|');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('uses the browser on the sign-in page (nobody signed in) and remembers the last language', async () => {
    browserLanguages(['es']);
    respond({ signedIn: false, language: { default: null, enabled: ['en', 'es'] } });
    expect(await mount()).toContain('Idioma|es|');
    expect(localStorage.getItem('oci.locale')).toBe('es');
  });

  it('decides with what it has when the instance settings cannot be read', async () => {
    respond({ saved: 'es', statusFails: true });
    // Nothing enables Spanish, so English; and no throw.
    expect(await mount()).toContain('Language|en|');
  });
});
