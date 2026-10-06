// @vitest-environment happy-dom
import type { InstanceSettings } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSearchPage } from '../../src/routes/admin/search';
import { button, cleanup, click, findButton, renderAdmin, settle } from './admin-test-utils';

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
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const features = {
  shareLinks: true,
  temporaryChat: false,
  webSearch: true,
  attachments: true,
  branching: true,
  memory: false,
};

let search: InstanceSettings['search'];
let root: Root | undefined;

beforeEach(() => {
  search = {
    enabled: true,
    provider: 'searchapi',
    baseUrl: null,
    hasCredential: true,
    maxResults: 5,
    fallbackProvider: null,
    fallbackBaseUrl: null,
    hasFallbackCredential: false,
  };
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/settings') return { features, search };
    if (path === '/admin/setup-status')
      return { requiredComplete: 0, requiredTotal: 0, checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function render() {
  ({ root } = await renderAdmin(<AdminSearchPage />));
}
async function choose(id: string, value: string) {
  const select = document.getElementById(id) as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('Web search fallback provider', () => {
  it('starts with no fallback and asks for nothing more', async () => {
    await render();
    expect((document.getElementById('search-fallback-provider') as HTMLSelectElement).value).toBe(
      'none',
    );
    expect(document.getElementById('search-fallback-api-key')).toBeNull();
    expect(document.getElementById('search-fallback-base-url')).toBeNull();
    expect(button('Save changes').disabled).toBe(true);
  });

  it('saves a hosted fallback with its own key, and needs the key', async () => {
    await render();
    await choose('search-fallback-provider', 'brave');
    expect(document.getElementById('search-fallback-base-url')).toBeNull();
    expect(document.body.textContent).toContain('Fallback Brave Search API key');

    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enter the fallback Brave Search API key, or choose no fallback.',
    );

    await type('search-fallback-api-key', ' brave-key ');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/admin/settings', {
      search: { fallbackProvider: 'brave', fallbackApiKey: 'brave-key' },
    });
    // Saved: the key is write-only and shown only as saved.
    expect(document.getElementById('search-fallback-api-key')).toBeNull();
    expect(document.body.textContent).toContain('Fallback Brave Search API key saved');
  });

  it('asks a SearXNG fallback only for its address', async () => {
    await render();
    await choose('search-fallback-provider', 'searxng');
    expect(document.getElementById('search-fallback-api-key')).toBeNull();
    await type('search-fallback-base-url', 'not a url');
    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enter a full address, starting with http:// or https://.',
    );

    await type('search-fallback-base-url', 'https://search2.example.edu');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
      search: { fallbackProvider: 'searxng', fallbackBaseUrl: 'https://search2.example.edu' },
    });
  });

  it('refuses the same hosted service, or the same SearXNG address, as the fallback', async () => {
    await render();
    await choose('search-fallback-provider', 'searchapi');
    await type('search-fallback-api-key', 'another-key');
    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Choose a different service than SearchApi for the fallback.',
    );

    await cleanup(root!);
    search = { ...search, provider: 'searxng', baseUrl: 'https://a.example.edu' };
    await render();
    await choose('search-fallback-provider', 'searxng');
    await type('search-fallback-base-url', 'https://a.example.edu');
    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'The fallback SearXNG must be at a different address.',
    );
  });

  it('keeps, replaces or removes a saved fallback key, and removes the fallback', async () => {
    search = { ...search, fallbackProvider: 'brave', hasFallbackCredential: true };
    await render();
    expect(document.body.textContent).toContain('Fallback Brave Search API key saved');
    await click(button('Replace fallback key'));
    await type('search-fallback-api-key', 'new-key');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenLastCalledWith('/admin/settings', {
      search: { fallbackApiKey: 'new-key' },
    });

    await click(button('Remove fallback key'));
    expect(document.body.textContent).toContain('It will be removed when you save');
    await click(button('Keep the saved key'));
    expect(findButton('Remove fallback key')).toBeTruthy();

    await choose('search-fallback-provider', 'none');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenLastCalledWith('/admin/settings', {
      search: { fallbackProvider: null },
    });
  });

  it('tests both providers and reports each result', async () => {
    search = { ...search, fallbackProvider: 'brave', hasFallbackCredential: true };
    api.post.mockResolvedValueOnce({
      ok: true,
      results: 3,
      fallback: { ok: false, message: 'Brave Search returned an error (HTTP 503).' },
    });
    await render();
    await click(button('Test search'));
    expect(api.post).toHaveBeenCalledWith('/admin/settings/search/test', {
      provider: 'searchapi',
      fallback: { provider: 'brave' },
    });
    expect(document.body.textContent).toContain(
      'SearchApi works: a test search returned 3 results.',
    );
    expect(document.body.textContent).toContain(
      'Fallback: Brave Search returned an error (HTTP 503).',
    );

    api.post.mockResolvedValueOnce({
      ok: false,
      message: 'SearchApi did not answer in time.',
      fallback: { ok: true, results: 1 },
    });
    await click(button('Test search'));
    expect(document.body.textContent).toContain('SearchApi did not answer in time.');
    expect(document.body.textContent).toContain(
      'Fallback Brave Search works: a test search returned 1 result.',
    );
  });

  it('tests a typed fallback key and address before saving', async () => {
    await render();
    await choose('search-fallback-provider', 'tavily');
    await type('search-fallback-api-key', 'tvly-typed');
    api.post.mockResolvedValueOnce({ ok: true, results: 2, fallback: { ok: true, results: 2 } });
    await click(button('Test search'));
    expect(api.post).toHaveBeenCalledWith('/admin/settings/search/test', {
      provider: 'searchapi',
      fallback: { provider: 'tavily', apiKey: 'tvly-typed' },
    });

    await choose('search-fallback-provider', 'searxng');
    await type('search-fallback-base-url', 'https://search2.example.edu');
    api.post.mockResolvedValueOnce({ ok: true, results: 2, fallback: { ok: true, results: 2 } });
    await click(button('Test search'));
    expect(api.post).toHaveBeenLastCalledWith('/admin/settings/search/test', {
      provider: 'searchapi',
      fallback: { provider: 'searxng', baseUrl: 'https://search2.example.edu' },
    });
  });
});
