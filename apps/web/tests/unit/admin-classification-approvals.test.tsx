// @vitest-environment happy-dom
import type { AdminConnector, AdminDataClass, AdminModel, Provider } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorFormDialog } from '../../src/components/admin/connector-form-dialog';
import { ModelFormDialog } from '../../src/components/admin/model-form-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { ApiError } from '../../src/lib/api-client';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { AdminConnectorsPage } from '../../src/routes/admin/connectors';
import { alerts, button, cleanup, click, dialog, renderAdmin, typeInto } from './admin-test-utils';

/**
 * Approving a model for data classes, and saying what a connector carries
 * (v0.14, #395): both start with nothing, which is a decision, not an omission.
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

const cls = (id: string, name: string, retired = false): AdminDataClass => ({
  id,
  name,
  description: '',
  retiredAt: retired ? '2026-10-02T09:00:00.000Z' : null,
  modelCount: 0,
  connectorCount: 0,
  projectCount: 0,
  threadCount: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
});
let classes: AdminDataClass[];
let mode: 'off' | 'warn' | 'block';

const provider = {
  id: 'p1',
  kind: 'openai-compatible',
  label: 'Gateway',
  baseUrl: 'https://gateway.example.test/v1',
  hasApiKey: true,
  enabled: true,
} as unknown as Provider;

function adminModel(overrides: Partial<AdminModel> = {}): AdminModel {
  return {
    id: 'm1',
    slug: 'big-model',
    displayName: 'Big model',
    description: null,
    providerId: 'p1',
    providerKind: 'openai-compatible',
    providerLabel: 'Gateway',
    labId: null,
    upstreamModelId: 'big-model',
    capabilities: [],
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    inputPriceMicros: null,
    outputPriceMicros: null,
    isDefault: false,
    sortOrder: 0,
    enabled: true,
    visibleToRoles: ['admin', 'user'],
    dataClassIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function connector(overrides: Partial<AdminConnector> = {}): AdminConnector {
  return {
    id: 'c1',
    name: 'SIS',
    slug: 'sis',
    url: 'https://sis.example.test/mcp',
    authMode: 'none',
    sharedHeaderName: 'Authorization',
    hasSharedCredential: false,
    oauthClientId: null,
    hasOauthClientSecret: false,
    oauthClientSource: null,
    oauthScopes: '',
    enabled: true,
    allowPrivateNetwork: false,
    dataClassIds: [],
    reviewed: false,
    accountCount: 0,
    lastContactAt: null,
    lastErrorAt: null,
    lastError: null,
    oauthRedirectUrl: 'https://oci.example.test/api/connectors/oauth/callback',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    tools: [],
    ...overrides,
  } as AdminConnector;
}

let root: Root | undefined;
let connectors: AdminConnector[];
beforeEach(() => {
  classes = [cls('c1', 'Student records'), cls('c2', 'Health data')];
  connectors = [];
  mode = 'block';
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/data-classes') return { classes };
    if (path === '/admin/connectors') return { connectors };
    if (path === '/admin/classification')
      return {
        mode,
        services: { webSearch: [], embeddings: [], reranking: [] },
        modeAvailable: true,
        backfillDone: true,
        unreviewedConnectorCount: 0,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  for (const method of [api.post, api.patch, api.delete, api.put])
    method.mockReset().mockResolvedValue({ id: 'm1' });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const box = (label: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    input.closest('label')?.textContent?.trim().startsWith(label),
  )!;
const fieldset = (legend: string) =>
  [...document.querySelectorAll('fieldset')].find(
    (node) => node.querySelector('legend')?.textContent === legend,
  )!;

describe('Models: Approved for', () => {
  const open = async (model: AdminModel | null) => {
    ({ root } = await renderAdmin(
      <ThemeProvider>
        <Dialog open>
          <ModelFormDialog model={model} providers={[provider]} onClose={vi.fn()} />
        </Dialog>
      </ThemeProvider>,
    ));
  };

  it('is empty by default and says what that means', async () => {
    await open(null);
    const group = fieldset('Approved for');
    expect(group.textContent).toContain('Student records');
    expect(group.textContent).toContain('Health data');
    expect(group.textContent).toContain('No class: this model cannot receive labelled content.');
    expect(
      [...group.querySelectorAll<HTMLInputElement>('input')].some((input) => input.checked),
    ).toBe(false);
  });

  it('shows the classes a model is approved for, and a retired one only while it is chosen', async () => {
    classes = [
      cls('c1', 'Student records'),
      cls('c2', 'Health data', true),
      cls('c3', 'Old data', true),
    ];
    await open(adminModel({ dataClassIds: ['c1', 'c2'] }));
    const group = fieldset('Approved for');
    expect(box('Student records').checked).toBe(true);
    expect(group.textContent).toContain('Health data(retired)');
    // Retired and not chosen: not offered.
    expect(group.textContent).not.toContain('Old data');
    expect(group.textContent).toContain('2 classes chosen.');
  });

  it('saves the model, then its approvals, only when they changed', async () => {
    await open(adminModel({ dataClassIds: ['c1'] }));
    await click(button('Save model'));
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();

    api.patch.mockClear();
    await click(box('Health data'));
    await click(button('Save model'));
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/admin/models/m1/data-classes', {
      classIds: ['c1', 'c2'],
    });
    expect(api.patch.mock.invocationCallOrder[0]!).toBeLessThan(
      api.put.mock.invocationCallOrder[0]!,
    );
  });

  it('approves a new model with the id the server gave it', async () => {
    api.post.mockResolvedValue({ id: 'new-model' });
    await open(null);
    await typeInto(document.querySelector<HTMLInputElement>('#upstream-model-id')!, 'tiny');
    await typeInto(document.querySelector<HTMLInputElement>('#model-display-name')!, 'Tiny');
    await click(box('Student records'));
    await click(button('Add model'));
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/admin/models/new-model/data-classes', {
      classIds: ['c1'],
    });
  });

  it('says the model was saved when only its approvals were not', async () => {
    api.put.mockRejectedValue(new ApiError(409, 'CONFLICT', 'That class was deleted.'));
    await open(adminModel());
    await click(box('Student records'));
    await click(button('Save model'));
    expect(alerts(dialog()!).join()).toBe(
      'The model was saved, but the classes it is approved for were not. That class was deleted.',
    );
  });

  it('points at the page to define classes when there are none', async () => {
    classes = [];
    await open(adminModel());
    expect(fieldset('Approved for').textContent).toContain('No data classes are defined yet.');
    expect(fieldset('Approved for').querySelector('a')?.getAttribute('href')).toBe(
      '/admin/data-classes',
    );
  });
});

describe('Connectors: Carries', () => {
  const open = async (existing: AdminConnector | null) => {
    ({ root } = await renderAdmin(
      <Dialog open>
        <ConnectorFormDialog connector={existing} onClose={vi.fn()} />
      </Dialog>,
    ));
  };
  const fill = async () => {
    await typeInto(document.querySelector<HTMLInputElement>('#connector-name')!, 'SIS');
    await typeInto(
      document.querySelector<HTMLInputElement>('#connector-url')!,
      'https://sis.example.test/mcp',
    );
  };

  it('has "Carries no classified data" beside the classes, and says a new one is not reviewed', async () => {
    await open(null);
    const group = fieldset('Carries');
    expect(group.textContent).toContain('Student records');
    expect(group.textContent).toContain('Carries no classified data');
    expect(group.textContent).toContain(
      'Not reviewed: choose what it carries, or say that it carries no classified data.',
    );
  });

  it('makes the two choices exclusive', async () => {
    await open(null);
    await click(box('Student records'));
    await click(box('Carries no classified data'));
    expect(box('Carries no classified data').checked).toBe(true);
    expect(box('Student records').checked).toBe(false);
    expect(fieldset('Carries').textContent).toContain('No classified data: conversations that use');
    await click(box('Health data'));
    expect(box('Carries no classified data').checked).toBe(false);
    expect(box('Health data').checked).toBe(true);
  });

  it('creates a connector with what it carries in the same request', async () => {
    await open(null);
    await fill();
    await click(box('Student records'));
    await click(button('Add connector'));
    const [path, body] = api.post.mock.calls[0]!;
    expect(path).toBe('/admin/connectors');
    expect(body).toMatchObject({ name: 'SIS', dataClassIds: ['c1'], reviewed: true });
  });

  it('creates a connector that carries nothing, on purpose', async () => {
    await open(null);
    await fill();
    await click(box('Carries no classified data'));
    await click(button('Add connector'));
    expect(api.post.mock.calls[0]![1]).toMatchObject({ dataClassIds: [], reviewed: true });
  });

  it('shows the 422 at the field when classification is on and it said neither', async () => {
    api.post.mockRejectedValue(
      new ApiError(
        422,
        'VALIDATION_FAILED',
        'Say which data classes this connector carries, or that it carries none.',
        [
          {
            path: ['dataClassIds'],
            message:
              'Choose the classes it carries, or confirm that it carries no classified data.',
          },
        ],
      ),
    );
    await open(null);
    await fill();
    await click(button('Add connector'));
    expect(api.post.mock.calls[0]![1]).not.toHaveProperty('dataClassIds');
    expect(fieldset('Carries').querySelector('[role="alert"]')?.textContent).toContain(
      'Choose the classes it carries, or confirm that it carries no classified data.',
    );
    // Choosing clears it.
    await click(box('Carries no classified data'));
    expect(fieldset('Carries').querySelector('[role="alert"]')).toBeNull();
  });

  it('changes what an existing connector carries with its own request, and only then', async () => {
    await open(connector({ dataClassIds: ['c1'], reviewed: true }));
    expect(box('Student records').checked).toBe(true);
    await click(button('Save changes'));
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();

    await click(box('Health data'));
    await click(button('Save changes'));
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.put).toHaveBeenCalledWith('/admin/connectors/c1/data-classes', {
      classIds: ['c1', 'c2'],
      reviewed: true,
    });
  });

  it('leaves an unreviewed connector unreviewed when only its name changes', async () => {
    await open(connector());
    await typeInto(document.querySelector<HTMLInputElement>('#connector-name')!, 'SIS 2');
    await click(button('Save changes'));
    expect(api.patch).toHaveBeenCalledWith('/admin/connectors/c1', { name: 'SIS 2' });
    expect(api.put).not.toHaveBeenCalled();
  });

  it('shows a connector that carries nothing as reviewed, and says the connector saved if only that failed', async () => {
    api.put.mockRejectedValue(new ApiError(409, 'CONFLICT', 'That class was deleted.'));
    await open(connector({ dataClassIds: [], reviewed: true }));
    expect(box('Carries no classified data').checked).toBe(true);
    await click(box('Student records'));
    await click(button('Save changes'));
    expect(alerts(dialog()!).join()).toBe(
      'The connector was saved, but what it carries was not. That class was deleted.',
    );
  });
});

describe('Connectors page: Not reviewed', () => {
  const render = async () => {
    ({ root } = await renderAdmin(<AdminConnectorsPage />, { path: '/admin/connectors' }));
  };
  const card = (name: string) =>
    [...document.querySelectorAll('[data-testid="connector"]')].find((node) =>
      node.querySelector('h2')?.textContent?.includes(name),
    )!;

  it('badges every connector nobody has reviewed, while classification is on', async () => {
    connectors = [
      connector(),
      connector({ id: 'c2', name: 'Wiki', slug: 'wiki', dataClassIds: [], reviewed: true }),
      connector({
        id: 'c3',
        name: 'Grades',
        slug: 'grades',
        dataClassIds: ['c1', 'c2'],
        reviewed: true,
      }),
    ];
    await render();
    expect(card('SIS').textContent).toContain('Not reviewed');
    expect(card('Wiki').textContent).not.toContain('Not reviewed');
    expect(card('Wiki').textContent).toContain('Carries no classified data');
    expect(card('Grades').textContent).toContain('Carries Student records, Health data');
  });

  it('says nothing about it while classification is off', async () => {
    mode = 'off';
    connectors = [connector()];
    await render();
    expect(card('SIS').textContent).not.toContain('Not reviewed');
    expect(card('SIS').textContent).not.toContain('Carries');
  });
});
