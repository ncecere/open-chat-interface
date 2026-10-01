// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminModelsPage } from '../../src/routes/admin/models';
import { AdminOverviewPage } from '../../src/routes/admin/overview';
import { ProvidersSection } from '../../src/routes/admin/providers';
import { AdminRolesPage } from '../../src/routes/admin/roles';
import { alerts, button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';

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
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setColorTheme: vi.fn() }),
}));

const provider = {
  id: 'provider-1',
  label: 'Primary OpenAI',
  kind: 'openai',
  enabled: true,
  baseUrl: null,
  credentialHint: 'abcd',
  modelCount: 2,
};

const model = {
  id: 'model-1',
  slug: 'gpt',
  displayName: 'GPT Test',
  labId: 'openai',
  providerId: provider.id,
  providerLabel: provider.label,
  upstreamModelId: 'gpt-test',
  enabled: true,
  isDefault: false,
  capabilities: ['vision'],
  visibleToRoles: ['user'],
};

const overview = {
  users: { total: 7, admins: 1 },
  threads: { total: 3, last24h: 1, previous24h: 0 },
  messages: { total: 12, last24h: 4, previous24h: 0 },
  storage: { totalBytes: 0, fileCount: 0 },
  activity: [],
  providers: { configured: 1 },
  models: { total: 1, enabled: 1 },
  system: { version: '0.5.0', database: 'ok', redis: 'ok' },
};

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('providers', () => {
  beforeEach(() => api.get.mockResolvedValue({ providers: [provider] }));

  it('asks before deleting and keeps the dialog open with the server error', async () => {
    api.delete.mockRejectedValue(new ApiError(409, 'CONFLICT', 'Provider is in use.'));
    ({ root } = await renderAdmin(<ProvidersSection />));

    await click(button('Delete Primary OpenAI'));
    expect(api.delete).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('2 catalog models will be removed');

    await click(button('Delete provider'));
    expect(api.delete).toHaveBeenCalledWith('/admin/providers/provider-1');
    expect(dialog()).not.toBeNull();
    expect(alerts(dialog()!)).toEqual(['The provider could not be deleted. Provider is in use.']);
  });

  it('reports a failed model discovery instead of failing silently', async () => {
    api.post.mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'Invalid API key.'));
    ({ root } = await renderAdmin(<ProvidersSection />));

    await click(button('Discover models'));
    expect(alerts()).toEqual([
      'Models could not be discovered for Primary OpenAI. Invalid API key.',
    ]);
    expect(dialog()).toBeNull();
  });

  it('shows a retryable error instead of an empty list when loading fails', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Database unavailable.'));
    api.get.mockResolvedValue({ providers: [provider] });
    ({ root } = await renderAdmin(<ProvidersSection />));

    expect(alerts()).toEqual(['Providers could not be loaded.']);
    expect(document.body.textContent).not.toContain('No providers configured yet.');
    await click(button('Try again'));
    expect(document.body.textContent).toContain('Primary OpenAI');
  });
});

function catalogResponses(path: string) {
  if (path === '/admin/models') return Promise.resolve({ models: [model] });
  if (path === '/admin/providers') return Promise.resolve({ providers: [provider] });
  if (path === '/admin/setup-status') {
    return Promise.resolve({ requiredComplete: 0, requiredTotal: 0, checks: [] });
  }
  return Promise.reject(new Error(`Unexpected GET ${path}`));
}

describe('model catalog', () => {
  it('shows a failed instant toggle and refetches the server state', async () => {
    api.get.mockImplementation(catalogResponses);
    api.patch.mockRejectedValue(new ApiError(400, 'VALIDATION_FAILED', 'Model is misconfigured.'));
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));
    const modelLoads = () => api.get.mock.calls.filter(([path]) => path === '/admin/models').length;
    const before = modelLoads();

    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Enable GPT Test"]')!;
    await click(toggle);

    expect(api.patch).toHaveBeenCalledWith('/admin/models/model-1', { enabled: false });
    expect(alerts()).toEqual(['Changes to GPT Test could not be saved. Model is misconfigured.']);
    expect(modelLoads()).toBeGreaterThan(before);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('confirms before removing a model', async () => {
    api.get.mockImplementation(catalogResponses);
    api.delete.mockResolvedValue({ ok: true });
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=models' }));

    await click(button('Remove GPT Test'));
    expect(api.delete).not.toHaveBeenCalled();
    await click(button('Cancel'));
    expect(api.delete).not.toHaveBeenCalled();

    await click(button('Remove GPT Test'));
    await click(button('Remove model'));
    expect(api.delete).toHaveBeenCalledWith('/admin/models/model-1');
    expect(dialog()).toBeNull();
  });
});

describe('load failures', () => {
  it('replaces the overview spinner with an error that retries', async () => {
    // The setup checklist loads separately and must not mask an overview failure.
    let overviewCalls = 0;
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/setup-status') {
        return { requiredComplete: 0, requiredTotal: 0, checks: [] };
      }
      overviewCalls += 1;
      if (overviewCalls === 1) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Database unavailable.');
      }
      return overview;
    });
    ({ root } = await renderAdmin(<AdminOverviewPage />));

    expect(document.querySelector('[aria-label="Loading page"]')).toBeNull();
    expect(alerts()).toEqual(['The overview could not be loaded.']);
    expect(document.body.textContent).toContain('Database unavailable.');

    await click(button('Try again'));
    expect(overviewCalls).toBe(2);
    expect(alerts()).toEqual([]);
    expect(document.body.textContent).toContain('Models in catalog');
  });

  it('shows role access load failures rather than spinning', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    ({ root } = await renderAdmin(<AdminRolesPage />));

    expect(alerts()).toEqual([
      'Role access could not be loaded.',
      'Instance-wide limits could not be loaded.',
    ]);
    expect(document.body.textContent).toContain('Check your connection and try again.');
    expect(document.querySelector('[aria-label="Loading role access"]')).toBeNull();
  });
});
