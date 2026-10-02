// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminBrandingPage } from '../../src/routes/admin/branding';
import { AdminModelsPage } from '../../src/routes/admin/models';
import { AdminSearchPage } from '../../src/routes/admin/search';
import { button, cleanup, click, renderAdmin, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
const theme = vi.hoisted(() => ({ setColorTheme: vi.fn() }));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setColorTheme: theme.setColorTheme }),
}));
// Radix Select needs layout APIs happy-dom lacks; a native select exercises
// the same value/onChange contract.
vi.mock('../../src/components/ui/select', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/ui/select')>()),
  Select: ({
    id,
    value,
    onChange,
    options,
    disabled,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: readonly { value: string; label: string }[];
    disabled?: boolean;
  }) => (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">None</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

let setupChecks: Array<Record<string, unknown>> = [];
let settings: Record<string, unknown>;

const features = {
  shareLinks: true,
  temporaryChat: false,
  webSearch: false,
  attachments: true,
  branching: true,
};

function model(id: string, providerId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    displayName: `Model ${id}`,
    labId: null,
    providerId,
    providerLabel: `Provider ${providerId}`,
    upstreamModelId: id,
    enabled: true,
    isDefault: false,
    capabilities: [],
    visibleToRoles: ['user'],
    ...overrides,
  };
}

const providers = [
  { id: 'p1', label: 'Provider p1', kind: 'openai', enabled: true, baseUrl: null, modelCount: 3 },
  { id: 'p2', label: 'Provider p2', kind: 'openai', enabled: false, baseUrl: null, modelCount: 1 },
];
const models = [
  model('m1', 'p1', { isDefault: true }),
  model('m2', 'p2'),
  model('m3', 'p1', { enabled: false }),
  model('m4', 'p1'),
];

let root: Root | undefined;
beforeEach(() => {
  setupChecks = [];
  settings = {
    appName: 'Review',
    shortName: null,
    logoUrl: null,
    accentColor: '#123456',
    loginMessage: null,
    defaultTheme: 'system',
    colorTheme: 'neutral',
    registrationMode: 'open',
    emailVerificationRequired: false,
    localAuthEnabled: true,
    sessionLifetimeDays: 30,
    sessionRefreshDays: 1,
    defaultSystemPrompt: null,
    features,
    storage: {
      driver: 'local',
      localPath: '/data',
      maxFileBytes: 1,
      maxFilesPerMessage: 1,
      allowedMimeTypes: [],
      s3: {
        bucket: '',
        region: '',
        endpoint: null,
        accessKeyId: '',
        forcePathStyle: false,
        hasCredential: false,
      },
    },
    search: {
      enabled: false,
      provider: 'searxng',
      baseUrl: 'http://search.test',
      hasCredential: false,
      maxResults: 5,
    },
    smtp: { configured: false, host: null, port: null, secure: false, fromAddress: null },
  };
  for (const method of Object.values(api)) method.mockReset();
  theme.setColorTheme.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/models') return { models };
    if (path === '/admin/providers') return { providers };
    if (path === '/admin/settings') return settings;
    if (path === '/admin/setup-status') {
      return { requiredComplete: 0, requiredTotal: 0, checks: setupChecks };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('Providers & Models', () => {
  it('separates providers and models into tabs, opening on providers', async () => {
    ({ root } = await renderAdmin(<AdminModelsPage />));
    expect(document.querySelector('h1')?.textContent).toBe('Providers & Models');
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Providers', 'Models', 'Embeddings']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const headings = () => [...document.querySelectorAll('h2')].map((node) => node.textContent);
    expect(headings()).toContain('Providers');
    expect(headings()).not.toContain('Model catalog');
  });

  it('opens the Models tab from the URL', async () => {
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));
    const models = [...document.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === 'Models',
    );
    expect(models?.getAttribute('aria-selected')).toBe('true');
    expect([...document.querySelectorAll('h2')].map((node) => node.textContent)).toContain(
      'Model catalog',
    );
  });

  it('offers only usable models as the default and saves the choice atomically', async () => {
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));
    const select = document.getElementById('default-model') as HTMLSelectElement;
    expect(select.value).toBe('m1');
    expect(
      [...select.options].map((option) => option.value).filter((value) => value !== ''),
    ).toEqual(['m1', 'm4']);

    await choose(select, 'm4');
    expect(api.patch).toHaveBeenCalledWith('/admin/models/m4', { isDefault: true });
    expect(document.body.textContent).toContain('Default model saved.');
  });

  it('warns when the setup check says the default is unusable', async () => {
    setupChecks = [
      {
        id: 'default-model',
        title: 'Default model',
        status: 'attention',
        required: true,
        detail: 'Model m1 is the default but is hidden from the user role.',
        action: { label: 'Open model catalog', to: '/admin/models' },
      },
    ];
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));
    expect(document.body.textContent).toContain(
      'Model m1 is the default but is hidden from the user role.',
    );
  });

  it('points an empty catalog at Discover models on the Providers tab', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/models') return { models: [] };
      if (path === '/admin/providers') return { providers };
      return { checks: [] };
    });
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));
    expect(document.body.textContent).toContain('Use Discover models on the Providers tab');
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Providers',
    );
    // Providers is the default tab, so the link carries no query.
    expect(link?.getAttribute('href')).toBe('/admin/models');
  });
});

describe('Web search', () => {
  it('turns search on with one switch that writes the feature and the service', async () => {
    ({ root } = await renderAdmin(<AdminSearchPage />));
    const toggle = document.getElementById('search-enabled') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await click(toggle);
    await click(button('Save changes'));

    expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
      search: { enabled: true },
      features: { ...features, webSearch: true },
    });
  });

  it('shows the switch off unless both halves are on, and leaves features alone otherwise', async () => {
    settings = { ...settings, features: { ...features, webSearch: true } };
    ({ root } = await renderAdmin(<AdminSearchPage />));
    expect(document.getElementById('search-enabled')?.getAttribute('aria-checked')).toBe('false');

    const maxResults = document.getElementById('search-max-results') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        maxResults,
        '8',
      );
      maxResults.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', { search: { maxResults: 8 } });
  });

  const labels = () => [...document.querySelectorAll('label')].map((label) => label.textContent);

  it('asks SearXNG only for its address', async () => {
    ({ root } = await renderAdmin(<AdminSearchPage />));
    expect(labels()).toContain('SearXNG address');
    expect(document.getElementById('search-api-key')).toBeNull();
    expect(document.body.textContent).not.toContain('API key');
  });

  it('asks a hosted provider only for its key, and needs it to turn search on', async () => {
    settings = {
      ...settings,
      search: { ...settings.search, provider: 'tavily', baseUrl: null, hasCredential: false },
    };
    ({ root } = await renderAdmin(<AdminSearchPage />));
    expect(labels()).toContain('Tavily API key');
    expect(document.getElementById('search-base-url')).toBeNull();
    expect(document.body.textContent).toContain('It starts with tvly-.');

    await click(document.getElementById('search-enabled') as HTMLButtonElement);
    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter the Tavily API key to enable search.');

    const key = document.getElementById('search-api-key') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        key,
        'tvly-test',
      );
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
      search: { enabled: true, apiKey: 'tvly-test' },
      features: { ...features, webSearch: true },
    });
  });

  it('offers SerpApi and keeps a saved key without asking for it again', async () => {
    settings = {
      ...settings,
      search: { ...settings.search, provider: 'serpapi', baseUrl: null, hasCredential: true },
    };
    ({ root } = await renderAdmin(<AdminSearchPage />));
    expect(document.body.textContent).toContain('SerpApi API key saved');
    expect(document.getElementById('search-api-key')).toBeNull();
    expect(button('Replace')).toBeTruthy();
    expect(button('Remove')).toBeTruthy();

    await click(document.getElementById('search-enabled') as HTMLButtonElement);
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
      search: { enabled: true },
      features: { ...features, webSearch: true },
    });
  });

  it('tests the provider on the page before saving and says what went wrong', async () => {
    api.post.mockResolvedValueOnce({
      ok: false,
      message: 'SearXNG returned an error (HTTP 403).',
    });
    ({ root } = await renderAdmin(<AdminSearchPage />));
    await click(button('Test search'));
    expect(api.post).toHaveBeenCalledWith('/admin/settings/search/test', {
      provider: 'searxng',
      baseUrl: 'http://search.test',
    });
    expect(document.body.textContent).toContain('SearXNG returned an error (HTTP 403).');

    api.post.mockResolvedValueOnce({ ok: true, results: 3 });
    await click(button('Test search'));
    expect(document.body.textContent).toContain('SearXNG works: a test search returned 3 results.');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('reports whether search can actually run', async () => {
    setupChecks = [
      {
        id: 'web-search',
        title: 'Web search',
        status: 'attention',
        required: false,
        detail: 'Web search is unavailable: no credential.',
        action: { label: 'Open web search', to: '/admin/search' },
      },
    ];
    ({ root } = await renderAdmin(<AdminSearchPage />));
    expect(document.body.textContent).toContain('Web search is not available');
    expect(document.body.textContent).toContain('Web search is unavailable: no credential.');
  });
});

describe('Branding accent', () => {
  it('picks a color theme preset, previews it, and never sends the hex accent', async () => {
    ({ root } = await renderAdmin(<AdminBrandingPage />));
    expect(document.getElementById('accent-color')).toBeNull();
    const preview = document.querySelector('[data-testid="branding-preview"]')!;
    expect(preview.getAttribute('data-color-theme')).toBe('neutral');

    const blue = document.querySelector<HTMLInputElement>(
      'input[name="color-theme"][value="blue"]',
    )!;
    await click(blue);
    expect(preview.getAttribute('data-color-theme')).toBe('blue');

    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', { colorTheme: 'blue' });
    expect(theme.setColorTheme).toHaveBeenCalledWith('blue');
  });
});
