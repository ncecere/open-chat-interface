// @vitest-environment happy-dom
import type { AdminModel } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTokenCount } from '../../src/components/admin/model-form-dialog';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { AdminModelsPage } from '../../src/routes/admin/models';
import { alerts, button, cleanup, click, dialog, renderAdmin, typeInto } from './admin-test-utils';
import { untitledTruncations } from './truncation';

/**
 * A model's context window and output limit, which the admin form could not
 * set: without them OCI budgets every model as 32,768 in, 4,096 out.
 */
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

function adminModel(overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id: 'm1',
    slug: 'big-model',
    displayName: 'Big model',
    description: null,
    providerId: 'p1',
    providerKind: 'openai',
    providerLabel: 'OpenAI',
    labId: 'openai',
    upstreamModelId: 'big-model',
    capabilities: [],
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    inputPriceMicros: null,
    outputPriceMicros: null,
    isDefault: true,
    sortOrder: 0,
    enabled: true,
    visibleToRoles: ['admin', 'user'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let model: AdminModel;
let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  model = adminModel();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/models') return { models: [model] };
    if (path === '/admin/providers') {
      return {
        providers: [
          {
            id: 'p1',
            label: 'OpenAI',
            kind: 'openai',
            enabled: true,
            baseUrl: 'https://gateway.example.edu/v1/openai-compatible',
            credentialHint: 'sk-…1234',
            modelCount: 1,
          },
        ],
      };
    }
    if (path === '/admin/setup-status') return { checks: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockResolvedValue({ id: 'm1' });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const page = (
  <ThemeProvider>
    <AdminModelsPage />
  </ThemeProvider>
);
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

async function openEditor() {
  ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
  await click(button('Edit Big model'));
}

describe('truncated text (#130)', () => {
  it.each(['models', 'providers'])('has a tooltip on the %s tab', async (tab) => {
    ({ root } = await renderAdmin(page, { path: `/admin/models?tab=${tab}` }));
    expect(document.body.textContent).toContain(tab === 'models' ? 'big-model' : 'gateway');
    expect(untitledTruncations()).toEqual([]);
  });
});

describe('model limits', () => {
  it('reads blank, thousands separators and anything else', () => {
    expect(parseTokenCount('')).toBeNull();
    expect(parseTokenCount('  ')).toBeNull();
    expect(parseTokenCount('200,000')).toBe(200_000);
    expect(parseTokenCount('64 000')).toBe(64_000);
    expect(parseTokenCount('12.5')).toBeNaN();
    expect(parseTokenCount('-5')).toBeNaN();
    expect(parseTokenCount('1e6')).toBeNaN();
  });

  it('explains the fallback for an unset model, in the row and the form', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(
      // The row's own toggle, which names the upstream model.
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.textContent?.endsWith('OpenAI · big-model'),
      )!,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Not set; OCI assumes 32,768 tokens');
    expect(text).toContain('Not set; OCI reserves 4,096 tokens');

    await click(button('Edit Big model'));
    expect(field('model-context-window').value).toBe('');
    expect(field('model-max-output').value).toBe('');
    const form = dialog()?.textContent ?? '';
    expect(form).toContain('Leave blank if unknown: OCI then assumes 32,768.');
    expect(form).toContain('OCI then reserves 4,096, or a quarter of the context window');
  });

  it('saves both limits', async () => {
    await openEditor();
    await typeInto(field('model-context-window'), '200,000');
    await typeInto(field('model-max-output'), '64000');
    await click(button('Save model'));

    expect(api.patch).toHaveBeenCalledWith(
      '/admin/models/m1',
      expect.objectContaining({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
    );
    expect(dialog()).toBeNull();
  });

  it('clears a limit back to unknown', async () => {
    model = adminModel({ contextWindow: 128_000, maxOutputTokens: 16_000 });
    await openEditor();
    expect(field('model-context-window').value).toBe('128000');
    await typeInto(field('model-max-output'), '');
    await click(button('Save model'));

    expect(api.patch).toHaveBeenCalledWith(
      '/admin/models/m1',
      expect.objectContaining({ contextWindow: 128_000, maxOutputTokens: null }),
    );
  });

  it('refuses a fraction, a ceiling breach and an output with no room for input', async () => {
    await openEditor();
    await typeInto(field('model-context-window'), '12.5');
    await click(button('Save model'));
    expect(alerts(dialog() as HTMLElement)).toEqual([
      'Context window must be a whole number of tokens.',
    ]);

    await typeInto(field('model-context-window'), '20000000');
    await click(button('Save model'));
    expect(alerts(dialog() as HTMLElement)).toEqual([
      'Context window can be at most 10,000,000 tokens.',
    ]);

    await typeInto(field('model-context-window'), '');
    await typeInto(field('model-max-output'), '40000');
    await click(button('Save model'));
    expect(alerts(dialog() as HTMLElement)[0]).toMatch(
      /keep it below 32,256 tokens \(the assumed context window, less 512\), or set the context window/,
    );
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('the model form and inline rename (#79)', () => {
  it('lists every problem with a new model at once', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(button('Add model'));
    // Upstream ID, display name and slug left blank; a fraction for max output.
    await typeInto(field('model-max-output'), '1.5');
    // The dialog's own Add model button, not the page's.
    const add = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === 'Add model',
    );
    await click(add!);
    const [alert] = alerts(dialog() as HTMLElement);
    expect(alert?.split('\n')).toEqual([
      'Max output must be a whole number of tokens.',
      'Upstream model ID is required.',
      'Display name is required.',
      'OCI slug is required.',
    ]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('clears the listed problems once the form is edited (#178)', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(button('Add model'));
    const add = () =>
      click(
        [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
          (candidate) => candidate.textContent?.trim() === 'Add model',
        )!,
      );
    await add();
    expect(alerts(dialog() as HTMLElement)[0]).toContain('Display name is required.');
    await typeInto(field('upstream-model-id'), 'walk3-upstream');
    await typeInto(field('model-display-name'), 'Walk3 model');
    expect(alerts(dialog() as HTMLElement)).toEqual([]);
  });

  it('lists a bad slug and an output with no room for input together (#129)', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(button('Add model'));
    await typeInto(field('upstream-model-id'), 'walk2-upstream');
    await typeInto(field('model-display-name'), 'Walk2 model');
    await typeInto(field('model-slug'), 'Walk2 Bad Slug');
    await typeInto(field('model-context-window'), '8,000');
    await typeInto(field('model-max-output'), '9000');
    const add = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === 'Add model',
    );
    await click(add!);
    const [alert] = alerts(dialog() as HTMLElement);
    expect(alert?.split('\n')).toEqual([
      'OCI slug: Slug must be lowercase alphanumeric with dashes',
      'The output limit must leave room for input: keep it below 7,488 tokens (the context window, less 512).',
    ]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('renames on Enter, once, and puts the name back on Escape', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.textContent?.endsWith('OpenAI · big-model'),
      )!,
    );
    const name = field('name-m1');
    const key = async (key: string) =>
      act(async () => {
        name.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });

    await typeInto(name, 'Walk renamed');
    await key('Escape');
    expect(name.value).toBe('Big model');
    expect(api.patch).not.toHaveBeenCalled();

    await typeInto(name, 'Walk renamed');
    await key('Enter');
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/admin/models/m1', { displayName: 'Walk renamed' });
  });

  it('does not leave a cleared name blank: it says why and puts the name back (#146)', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.textContent?.endsWith('OpenAI · big-model'),
      )!,
    );
    const name = field('name-m1');
    await typeInto(name, '   ');
    await act(async () => {
      name.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(api.patch).not.toHaveBeenCalled();
    const note = document.getElementById(name.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('A display name is required, so Big model was kept.');
    expect(name.value).toBe('Big model');
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(name.value).toBe('Big model');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('puts the name back even when the field was emptied without an input React saw (#146)', async () => {
    ({ root } = await renderAdmin(page, { path: '/admin/models?tab=models' }));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.textContent?.endsWith('OpenAI · big-model'),
      )!,
    );
    const name = field('name-m1');
    // What the walk's browser tool did: set the value directly. React tracks
    // that assignment, so the input event that follows changes no state.
    await act(async () => {
      name.value = '';
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(name.value).toBe('');
    await act(async () => {
      name.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(name.value).toBe('Big model');
    expect(api.patch).not.toHaveBeenCalled();
  });
});
