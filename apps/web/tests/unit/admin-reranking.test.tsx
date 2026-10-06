// @vitest-environment happy-dom
import type { EmbeddingsStatus, RerankingStatus } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingsSection } from '../../src/components/admin/embeddings-section';
import { RerankingSection, rerankingChanges } from '../../src/components/admin/reranking-section';
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

const ENDPOINT = 'http://reranker.internal:8080/v1/rerank';

function status(overrides: Partial<RerankingStatus> = {}): RerankingStatus {
  return {
    settings: { enabled: false, providerId: null, modelId: null, searchPriceMicros: null },
    providers: [{ id: 'p1', label: 'Local vLLM', kind: 'openai-compatible', endpoint: ENDPOINT }],
    endpoint: null,
    active: false,
    ...overrides,
  };
}

const configured = {
  enabled: true,
  providerId: 'p1',
  modelId: 'bge-reranker-v2-m3',
  searchPriceMicros: 2_000_000,
};

const embeddings: EmbeddingsStatus = {
  settings: {
    enabled: false,
    providerId: null,
    modelId: null,
    dimensions: null,
    inputPriceMicros: null,
  },
  pgvector: { state: 'not-installed', version: null },
  providers: [],
  active: false,
  storageDimensions: null,
  passages: { total: 0, embedded: 0 },
  failures: { files: 0, lastError: null },
  generations: { current: null, filling: null, retired: [], switchBlocked: null },
  estimate: { passages: 0, averageTokens: 0 },
};

let root: Root | undefined;
let current: RerankingStatus;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  current = status();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/reranking') return current;
    if (path === '/admin/embeddings') return embeddings;
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const text = () => document.body.textContent ?? '';
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('Providers & Models → Embeddings → Reranking', () => {
  it('sits on the Embeddings tab and says it works without pgvector', async () => {
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('pgvector is not installed on the database server');
    const heading = [...document.querySelectorAll('h2')].find(
      (candidate) => candidate.textContent === 'Reranking',
    );
    expect(heading).toBeDefined();
    expect(text()).toContain('Works with or without pgvector');
    // Empty, with a placeholder, rather than a value that reads as the endpoint (#157).
    expect(input('reranking-endpoint').value).toBe('');
    expect(document.getElementById('reranking-enabled')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('shows the saved model, its price and the resolved endpoint', async () => {
    current = status({ settings: configured, endpoint: ENDPOINT, active: true });
    ({ root } = await renderAdmin(<RerankingSection />));
    expect(input('reranking-model').value).toBe('bge-reranker-v2-m3');
    expect(input('reranking-price').value).toBe('2');
    expect(input('reranking-endpoint').value).toBe(ENDPOINT);
    expect(document.querySelector('[data-reranking-state]')?.textContent).toBe(
      'Reranking is on with bge-reranker-v2-m3.',
    );
  });

  it('warns when reranking is on but its provider is unavailable', async () => {
    current = status({ settings: configured, providers: [], endpoint: null, active: false });
    ({ root } = await renderAdmin(<RerankingSection />));
    expect(document.querySelector('[data-reranking-state]')?.textContent).toContain(
      'provider is unavailable',
    );
    expect(text()).toContain('Add an OpenAI-compatible provider');
  });

  it('tests the model on the page, reporting latency or the failure', async () => {
    current = status({ settings: { ...configured, enabled: false } });
    api.post.mockResolvedValue({ ok: true, latencyMs: 87, endpoint: ENDPOINT });
    ({ root } = await renderAdmin(<RerankingSection />));

    await typeInto(input('reranking-model'), 'rerank-v3.5');
    await click(button('Test reranking'));
    expect(api.post).toHaveBeenCalledWith('/admin/reranking/test', {
      providerId: 'p1',
      modelId: 'rerank-v3.5',
    });
    expect(text()).toContain('Works: reranked a sample in 87 ms.');

    api.post.mockResolvedValue({
      ok: false,
      message: 'The model could not rerank a sample: Local vLLM returned an error (HTTP 404).',
    });
    await click(button('Test reranking'));
    expect(text()).toContain('Local vLLM returned an error (HTTP 404).');

    api.post.mockRejectedValue(new Error('offline'));
    await click(button('Test reranking'));
    expect(text()).toContain('The test could not be run.');
  });

  it('says why Test reranking is unavailable (#157)', async () => {
    ({ root } = await renderAdmin(<RerankingSection />));
    const testButton = button('Test reranking');
    const reason = () =>
      document.getElementById(testButton.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(testButton.disabled).toBe(true);
    expect(reason()).toBe('Choose a provider to test reranking.');

    await click(document.getElementById('reranking-provider') as HTMLElement);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === 'Local vLLM',
      )!,
    );
    expect(input('reranking-endpoint').value).toBe(ENDPOINT);
    expect(reason()).toBe('Enter a model id to test reranking.');

    await typeInto(input('reranking-model'), 'bge-reranker-v2-m3');
    expect(testButton.disabled).toBe(false);
    expect(testButton.getAttribute('aria-describedby')).toBeNull();
  });

  it('saves only what changed', async () => {
    current = status({ settings: { ...configured, enabled: false } });
    ({ root } = await renderAdmin(<RerankingSection />));
    await typeInto(input('reranking-model'), 'jina-reranker-v2-base-multilingual');
    await click(document.getElementById('reranking-enabled') as HTMLElement);
    api.put.mockResolvedValue(
      status({
        settings: { ...configured, modelId: 'jina-reranker-v2-base-multilingual' },
        endpoint: ENDPOINT,
        active: true,
      }),
    );
    await click(button('Save changes'));
    expect(api.put).toHaveBeenCalledWith('/admin/reranking', {
      enabled: true,
      modelId: 'jina-reranker-v2-base-multilingual',
    });
    expect(text()).toContain('Reranking settings saved.');
    expect(text()).toContain('Reranking is on with jina-reranker-v2-base-multilingual.');
  });

  it('refuses a negative price and reports a failed save', async () => {
    current = status({ settings: configured, endpoint: ENDPOINT, active: true });
    api.put.mockRejectedValue(new Error('boom'));
    ({ root } = await renderAdmin(<RerankingSection />));
    await typeInto(input('reranking-price'), '-1');
    expect(text()).toContain('Enter a price of zero or more');
    expect(button('Save changes').disabled).toBe(true);
    await typeInto(input('reranking-price'), '');
    await click(button('Save changes'));
    expect(api.put).toHaveBeenCalledWith('/admin/reranking', { searchPriceMicros: null });
    expect(text()).toContain('The reranking settings could not be saved.');
  });

  it('is read-only for auditors', async () => {
    current = status({ settings: configured, endpoint: ENDPOINT, active: true });
    ({ root } = await renderAdmin(<RerankingSection />, { role: 'auditor' }));
    expect(findButton('Test reranking')).toBeUndefined();
    expect(findButton('Save changes')).toBeUndefined();
    expect(input('reranking-model').closest('fieldset')?.disabled).toBe(true);
    expect(input('reranking-endpoint').value).toBe(ENDPOINT);
  });

  it('shows a retry when the state cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('down'));
    ({ root } = await renderAdmin(<RerankingSection />));
    expect(text()).toContain('The reranking settings could not be loaded.');
  });

  it('computes changes field by field', () => {
    const saved = status({ settings: configured }).settings;
    expect(
      rerankingChanges(saved, {
        enabled: true,
        providerId: 'p1',
        modelId: ' bge-reranker-v2-m3 ',
        price: '2',
      }),
    ).toEqual({});
    expect(
      rerankingChanges(saved, { enabled: false, providerId: '', modelId: '', price: 'x' }),
    ).toEqual({ enabled: false, providerId: null, modelId: null });
    expect(
      rerankingChanges(saved, { enabled: true, providerId: 'p1', modelId: 'm', price: '0.5' }),
    ).toEqual({ modelId: 'm', searchPriceMicros: 500_000 });
  });
});
