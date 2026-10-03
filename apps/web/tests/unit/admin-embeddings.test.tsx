// @vitest-environment happy-dom
import type { EmbeddingsStatus } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingsSection,
  embeddingsChanges,
  PGVECTOR_DOCS_URL,
} from '../../src/components/admin/embeddings-section';
import { validateModelsSearch } from '../../src/lib/admin-search';
import { AdminModelsPage } from '../../src/routes/admin/models';
import { button, cleanup, click, findButton, renderAdmin, typeInto } from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function status(overrides: Partial<EmbeddingsStatus> = {}): EmbeddingsStatus {
  return {
    settings: {
      enabled: false,
      providerId: null,
      modelId: null,
      dimensions: null,
      inputPriceMicros: null,
    },
    pgvector: { state: 'available', version: null },
    providers: [{ id: 'p1', label: 'OpenAI', kind: 'openai' }],
    active: false,
    storageDimensions: null,
    passages: { total: 0, embedded: 0 },
    failures: { files: 0, lastError: null },
    ...overrides,
  };
}

const configured = {
  enabled: true,
  providerId: 'p1',
  modelId: 'text-embedding-3-small',
  dimensions: 1536,
  inputPriceMicros: 20_000,
};

let root: Root | undefined;
let current: EmbeddingsStatus;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  current = status();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/embeddings') return current;
    // The Reranking section shares the tab; its own tests are in admin-reranking.test.tsx.
    if (path === '/admin/reranking') {
      return {
        settings: { enabled: false, providerId: null, modelId: null, searchPriceMicros: null },
        providers: [],
        endpoint: null,
        active: false,
      };
    }
    if (path === '/admin/models') return { models: [] };
    if (path === '/admin/providers') return { providers: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const text = () => document.body.textContent ?? '';
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('Providers & Models → Embeddings', () => {
  it('is a tab of its own, opened from the URL', async () => {
    expect(validateModelsSearch({ tab: 'embeddings' })).toEqual({ tab: 'embeddings' });
    ({ root } = await renderAdmin(<AdminModelsPage />, { path: '/admin/models?tab=embeddings' }));
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (candidate) => candidate.textContent === 'Embeddings',
    );
    expect(tab?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe(
      'Embeddings',
    );
    expect(text()).toContain('Embeddings model');
  });

  it('tells the operator how to enable pgvector when it is installed but not enabled', async () => {
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('pgvector is installed but not enabled');
    expect(document.querySelector('pre code')?.textContent).toBe(
      'CREATE EXTENSION IF NOT EXISTS vector;',
    );
    expect(document.querySelector(`a[href="${PGVECTOR_DOCS_URL}"]`)).not.toBeNull();
  });

  it('explains the image change and the dump-and-restore caveat when pgvector is missing', async () => {
    current = status({ pgvector: { state: 'not-installed', version: null } });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('pgvector is not installed on the database server');
    expect(text()).toContain('pgvector/pgvector:pg17');
    expect(text()).toContain('must be a dump and restore');
    expect(document.querySelector(`a[href="${PGVECTOR_DOCS_URL}"]`)).not.toBeNull();
  });

  it('waits for pgvector when a model is configured without it', async () => {
    current = status({ settings: configured });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(document.querySelector('[data-embeddings-progress="waiting"]')?.textContent).toContain(
      'Waiting for pgvector',
    );
    expect(input('embeddings-dimensions').value).toBe('1536');
  });

  it('shows progress and failing files when meaning-based search is on', async () => {
    current = status({
      settings: configured,
      pgvector: { state: 'enabled', version: '0.8.6' },
      active: true,
      storageDimensions: 1536,
      passages: { total: 1200, embedded: 300 },
      failures: { files: 2, lastError: 'rate limited' },
    });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('pgvector 0.8.6 is enabled');
    expect(document.querySelector('[data-embeddings-progress="active"]')?.textContent).toContain(
      '300 of 1,200 passages embedded (1536 dimensions)',
    );
    expect(text()).toContain('2 files are waiting to be retried. Last error: rate limited');
    expect(input('embeddings-model').value).toBe('text-embedding-3-small');
    expect(input('embeddings-price').value).toBe('0.02');
  });

  it('says when storage is still being prepared', async () => {
    current = status({ settings: configured, pgvector: { state: 'enabled', version: '0.8.6' } });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(document.querySelector('[data-embeddings-progress="waiting"]')?.textContent).toContain(
      'being prepared',
    );
  });

  it('tests the model on the page and saves only what changed', async () => {
    current = status({ settings: { ...configured, enabled: false } });
    api.post.mockResolvedValue({ ok: true, dimensions: 768 });
    ({ root } = await renderAdmin(<EmbeddingsSection />));

    await typeInto(input('embeddings-model'), 'nomic-embed-text');
    await click(button('Test model'));
    expect(api.post).toHaveBeenCalledWith('/admin/embeddings/test', {
      providerId: 'p1',
      modelId: 'nomic-embed-text',
    });
    expect(text()).toContain('Works: 768 dimensions.');

    api.post.mockResolvedValue({ ok: false, message: 'The model could not embed a sample: 404' });
    await click(button('Test model'));
    expect(text()).toContain('The model could not embed a sample: 404');

    api.put.mockResolvedValue(
      status({ settings: { ...configured, enabled: false, modelId: 'nomic-embed-text' } }),
    );
    await click(button('Save changes'));
    expect(api.put).toHaveBeenCalledWith('/admin/embeddings', { modelId: 'nomic-embed-text' });
    expect(text()).toContain('Embeddings settings saved.');
  });

  it('refuses a negative price and reports a failed save', async () => {
    current = status({ settings: configured });
    api.put.mockRejectedValue(new Error('boom'));
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    await typeInto(input('embeddings-price'), '-1');
    expect(text()).toContain('Enter a price of zero or more');
    expect(button('Save changes').disabled).toBe(true);
    await typeInto(input('embeddings-price'), '');
    await click(button('Save changes'));
    expect(api.put).toHaveBeenCalledWith('/admin/embeddings', { inputPriceMicros: null });
    expect(text()).toContain('The embeddings settings could not be saved.');
  });

  it('is read-only for auditors', async () => {
    current = status({ settings: configured });
    ({ root } = await renderAdmin(<EmbeddingsSection />, { role: 'auditor' }));
    expect(findButton('Test model')).toBeUndefined();
    expect(findButton('Save changes')).toBeUndefined();
    // A disabled fieldset disables every control inside it.
    expect(input('embeddings-model').closest('fieldset')?.disabled).toBe(true);
    expect(text()).toContain('pgvector is installed but not enabled');
  });

  it('shows a retry when the state cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('down'));
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('The embeddings settings could not be loaded.');
  });

  it('computes changes field by field', () => {
    const saved = status({ settings: configured }).settings;
    const draft = {
      enabled: true,
      providerId: 'p1',
      modelId: ' text-embedding-3-small ',
      price: '0.02',
    };
    expect(embeddingsChanges(saved, draft)).toEqual({});
    expect(
      embeddingsChanges(saved, { enabled: false, providerId: '', modelId: '', price: 'x' }),
    ).toEqual({ enabled: false, providerId: null, modelId: null });
  });
});
