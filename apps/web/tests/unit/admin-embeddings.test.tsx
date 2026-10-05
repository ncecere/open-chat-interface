// @vitest-environment happy-dom
import type { EmbeddingGenerationStatus, EmbeddingsStatus } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingsSection,
  embeddingsChanges,
  formatDollars,
  formatEta,
  PGVECTOR_DOCS_URL,
} from '../../src/components/admin/embeddings-section';
import { validateModelsSearch } from '../../src/lib/admin-search';
import { AdminModelsPage } from '../../src/routes/admin/models';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
} from './admin-test-utils';

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
    generations: { current: null, filling: null, retired: [], switchBlocked: null },
    estimate: { passages: 0, averageTokens: 0 },
    ...overrides,
  };
}

function generation(overrides: Partial<EmbeddingGenerationStatus> = {}): EmbeddingGenerationStatus {
  return {
    id: 1,
    state: 'current',
    providerId: 'p1',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    inputPriceMicros: 20_000,
    createdAt: '2026-10-01T00:00:00.000Z',
    switchedAt: null,
    dropAfter: null,
    storageReady: true,
    storage: 'ready',
    passages: { total: 1200, embedded: 1200 },
    perMinute: 0,
    etaSeconds: 0,
    failures: { files: 0, lastError: null },
    ...overrides,
  };
}

/** Searches on generation 1 while generation 2 (another model) fills. */
function rebuilding(overrides: Partial<EmbeddingsStatus['generations']> = {}): EmbeddingsStatus {
  return status({
    settings: { ...configured, modelId: 'text-embedding-3-large', dimensions: 3072 },
    pgvector: { state: 'enabled', version: '0.8.6' },
    active: true,
    storageDimensions: 1536,
    passages: { total: 1200, embedded: 1200 },
    generations: {
      current: generation(),
      filling: generation({
        id: 2,
        state: 'filling',
        modelId: 'text-embedding-3-large',
        dimensions: 3072,
        inputPriceMicros: 130_000,
        passages: { total: 1200, embedded: 300 },
        perMinute: 450,
        etaSeconds: 120,
        failures: { files: 1, lastError: 'rate limited' },
      }),
      retired: [],
      switchBlocked: null,
      ...overrides,
    },
    estimate: { passages: 1200, averageTokens: 250 },
  });
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

  it('shows a rebuild in progress, and switches or cancels it after a confirmation', async () => {
    current = rebuilding();
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(document.querySelector('[data-embeddings-progress="active"]')?.textContent).toContain(
      '1,200 of 1,200 passages embedded (1536 dimensions) with text-embedding-3-small',
    );
    const panel = document.querySelector('[data-embeddings-rebuild="2"]')!;
    expect(panel.textContent).toContain('Rebuilding for text-embedding-3-large (3072 dimensions)');
    expect(panel.textContent).toContain(
      'Searches keep using text-embedding-3-small until the new model covers every passage',
    );
    expect(panel.querySelector('[data-embeddings-rebuild-progress]')?.textContent).toBe(
      '300 of 1,200 passages embedded (25%). 450 passages a minute; about 2 minutes left.',
    );
    expect(panel.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    expect(panel.textContent).toContain(
      '1 file is waiting to be retried. Last error: rate limited',
    );
    // The form shows the model being rebuilt for, the one chosen.
    expect(input('embeddings-model').value).toBe('text-embedding-3-large');

    const switched = rebuilding({
      current: generation({ id: 2, modelId: 'text-embedding-3-large', dimensions: 3072 }),
      filling: null,
      retired: [generation({ state: 'retired', dropAfter: '2026-10-05T12:00:00.000Z' })],
    });
    api.post.mockResolvedValue(switched);
    await click(button('Switch now'));
    expect(dialog()?.textContent).toContain('Switch searches to text-embedding-3-large now?');
    expect(dialog()?.textContent).toContain(
      '900 passages (75%) are not embedded with text-embedding-3-large yet. Until the rebuild reaches them, they are found by keyword only.',
    );
    expect(api.post).not.toHaveBeenCalled();
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Switch now',
    )!;
    await click(confirm);
    expect(api.post).toHaveBeenCalledWith('/admin/embeddings/generations/2/switch', {
      force: true,
    });
    expect(dialog()).toBeNull();
    expect(document.querySelector('[data-embeddings-rebuild]')).toBeNull();
    expect(document.querySelector('[data-embeddings-retired]')?.textContent).toContain(
      'Embeddings of text-embedding-3-small are kept until',
    );
  });

  it('cancels a rebuild', async () => {
    current = rebuilding();
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    api.post.mockResolvedValue(status({ settings: configured }));
    await click(button('Cancel rebuild'));
    expect(dialog()?.textContent).toContain('Cancel the rebuild for text-embedding-3-large?');
    expect(dialog()?.textContent).toContain('Searches stay on text-embedding-3-small');
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Cancel rebuild',
    )!;
    await click(confirm);
    expect(api.post).toHaveBeenCalledWith('/admin/embeddings/generations/2/cancel', {});
    expect(document.querySelector('[data-embeddings-rebuild]')).toBeNull();
  });

  it('holds the switch while the upgrade is unfinished, and hides the actions from auditors', async () => {
    current = rebuilding({ switchBlocked: 'upgrade-in-progress' });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(text()).toContain('The switch waits for the upgrade to finish');
    expect(text()).toContain('migrate --post');
    expect(button('Switch now').disabled).toBe(true);
    await cleanup(root!);
    ({ root } = await renderAdmin(<EmbeddingsSection />, { role: 'auditor' }));
    expect(document.querySelector('[data-embeddings-rebuild="2"]')).not.toBeNull();
    expect(findButton('Switch now')).toBeUndefined();
    expect(findButton('Cancel rebuild')).toBeUndefined();
  });

  it('shows what a model change costs before it is saved', async () => {
    current = status({
      settings: configured,
      pgvector: { state: 'enabled', version: '0.8.6' },
      active: true,
      storageDimensions: 1536,
      passages: { total: 40_000, embedded: 40_000 },
      generations: { current: generation(), filling: null, retired: [], switchBlocked: null },
      estimate: { passages: 40_000, averageTokens: 250 },
    });
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    expect(document.querySelector('[data-embeddings-estimate]')).toBeNull();
    await typeInto(input('embeddings-model'), 'text-embedding-3-large');
    await typeInto(input('embeddings-price'), '0.13');
    const estimate = document.querySelector('[data-embeddings-estimate="rebuild"]')!;
    expect(estimate.textContent).toContain('Changing the model re-embeds every passage');
    // 40,000 passages × 250 tokens × $0.13 per million tokens.
    expect(estimate.textContent).toContain(
      '40,000 passages, about 10,000,000 tokens, are embedded with text-embedding-3-large in the background. About $1.30 at the price entered.',
    );
    expect(estimate.textContent).toContain(
      'Searches keep using text-embedding-3-small until the new model covers every passage',
    );
    await typeInto(input('embeddings-price'), '');
    expect(document.querySelector('[data-embeddings-estimate]')?.textContent).toContain(
      'Enter a price to estimate the cost.',
    );
  });

  it('says that choosing the current model again cancels the rebuild', async () => {
    current = rebuilding();
    ({ root } = await renderAdmin(<EmbeddingsSection />));
    await typeInto(input('embeddings-model'), 'text-embedding-3-small');
    expect(document.querySelector('[data-embeddings-estimate="cancel"]')?.textContent).toContain(
      'Saving cancels the rebuild',
    );
  });

  it('formats costs and remaining time', () => {
    expect(formatDollars(1_300_000)).toBe('$1.30');
    expect(formatDollars(4_000)).toBe('less than $0.01');
    expect(formatDollars(0)).toBe('$0.00');
    expect(formatEta(30)).toBe('less than a minute');
    expect(formatEta(60)).toBe('about 1 minute');
    expect(formatEta(7_200)).toBe('about 2 hours');
    expect(formatEta(5 * 86_400)).toBe('about 5 days');
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
