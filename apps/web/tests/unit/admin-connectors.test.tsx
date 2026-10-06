// @vitest-environment happy-dom
import { type AdminConnector, createConnectorSchema } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorChanges } from '../../src/components/admin/connector-form-dialog';
import { toolGroups } from '../../src/components/admin/role-tools-form';
import { AdminConnectorsPage } from '../../src/routes/admin/connectors';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
  validationFailure,
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

function connector(overrides: Partial<AdminConnector> = {}): AdminConnector {
  return {
    id: 'c1',
    name: 'Docs',
    slug: 'docs',
    url: 'https://mcp.example.test/mcp',
    authMode: 'shared',
    sharedHeaderName: 'Authorization',
    hasSharedCredential: true,
    oauthClientId: null,
    hasOauthClientSecret: false,
    oauthClientSource: null,
    oauthScopes: '',
    enabled: true,
    allowPrivateNetwork: false,
    accountCount: 0,
    lastContactAt: '2026-10-01T10:00:00.000Z',
    lastErrorAt: null,
    lastError: null,
    oauthRedirectUrl: 'https://oci.example.test/api/connectors/oauth/callback',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    tools: [
      {
        id: 't1',
        toolId: 'mcp__docs__search',
        name: 'search',
        title: 'Search documents',
        description: 'Finds documents.',
        kind: 'read',
        serverKind: 'read',
        enabled: false,
        missing: false,
        lastSeenAt: '2026-10-01T10:00:00.000Z',
      },
      {
        id: 't2',
        toolId: 'mcp__docs__create_page',
        name: 'create_page',
        title: null,
        description: 'Creates a page.',
        kind: 'write',
        serverKind: 'write',
        enabled: true,
        missing: false,
        lastSeenAt: '2026-10-01T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

let root: Root | undefined;
let connectors: AdminConnector[];
beforeEach(() => {
  connectors = [connector()];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/connectors') return { connectors };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ ok: true, detail: 'Connected to Docs 1.0 · 2 tools' });
  api.patch.mockReset().mockResolvedValue({});
  api.delete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin', path = '/admin/connectors') => {
  ({ root } = await renderAdmin(<AdminConnectorsPage />, { role, path }));
};

describe('Connectors admin page', () => {
  it('lists connectors with credentials as set or not set, and their tools', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Docs');
    expect(text).toContain('Shared credential');
    expect(text).toContain('Authorization set');
    expect(text).toContain('Search documents');
    expect(text).toContain('create_page');
    expect(text).toContain('Roles & access');
    const toggle = document.getElementById('connector-tool-t1') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('enables a tool, tests the connection and refreshes tools', async () => {
    await render();
    await click(document.getElementById('connector-tool-t1')!);
    expect(api.patch).toHaveBeenCalledWith('/admin/connectors/c1/tools/t1', { enabled: true });
    const listReads = () =>
      api.get.mock.calls.filter(([path]) => path === '/admin/connectors').length;
    const before = listReads();
    await click(button('Test connection'));
    expect(api.post).toHaveBeenCalledWith('/admin/connectors/c1/test');
    // The row's "Last contact" follows the test, without Refresh (#84).
    await vi.waitFor(() => expect(listReads()).toBeGreaterThan(before));
    expect(document.body.textContent).toContain(
      'Connection works. Connected to Docs 1.0 · 2 tools',
    );
    api.post.mockResolvedValueOnce({ added: 1, updated: 1, missing: 0, tools: [] });
    await click(button('Refresh tools'));
    expect(api.post).toHaveBeenCalledWith('/admin/connectors/c1/refresh');
    expect(document.body.textContent).toContain(
      'Tools refreshed: 1 new, 1 updated, 0 no longer listed.',
    );
  });

  it('asks for confirmation before marking a server-declared write tool read', async () => {
    await render();
    await click(button('Kind of create_page'));
    const read = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.startsWith('Read'),
    )!;
    await click(read);
    expect(api.patch).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('does not declare this tool read-only');
    await click(button('Mark as read'));
    expect(api.patch).toHaveBeenCalledWith('/admin/connectors/c1/tools/t2', {
      kind: 'read',
      confirmReadOnly: true,
    });
  });

  it('adds a connector, sending the credential only once', async () => {
    connectors = [];
    await render();
    expect(document.body.textContent).toContain('No connectors yet.');
    await click(button('Add connector'));
    await typeInto(document.getElementById('connector-name') as HTMLInputElement, 'Wiki');
    await typeInto(
      document.getElementById('connector-url') as HTMLInputElement,
      'https://wiki.example.test/mcp',
    );
    api.post.mockResolvedValueOnce({ id: 'c2' });
    // The page's button opened the dialog; its submit button is the one inside it.
    const submit = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Add connector',
    )!;
    await click(submit);
    expect(api.post).toHaveBeenCalledWith('/admin/connectors', {
      name: 'Wiki',
      url: 'https://wiki.example.test/mcp',
      authMode: 'none',
      sharedHeaderName: 'Authorization',
      oauthScopes: '',
      enabled: true,
      allowPrivateNetwork: false,
    });
  });

  it('says which field the API refused and why (#127)', async () => {
    connectors = [];
    await render();
    await click(button('Add connector'));
    await typeInto(document.getElementById('connector-name') as HTMLInputElement, 'Walk2');
    await typeInto(
      document.getElementById('connector-url') as HTMLInputElement,
      'https://wiki.example.test/mcp',
    );
    await typeInto(document.getElementById('connector-slug') as HTMLInputElement, 'Walk2 Bad!');
    api.post.mockRejectedValueOnce(
      validationFailure(createConnectorSchema, {
        name: 'Walk2',
        url: 'https://wiki.example.test/mcp',
        slug: 'Walk2 Bad!',
        authMode: 'none',
      }),
    );
    const submit = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Add connector',
    )!;
    await click(submit);
    const alert = dialog()?.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe(
      'Short name: Use up to 24 lowercase letters, digits and hyphens, such as docs or crm-eu.',
    );
  });

  it('confirms before deleting, naming what goes with it', async () => {
    await render();
    await click(button('Delete Docs'));
    expect(dialog()?.textContent).toContain('2 tools');
    await click(button('Delete connector'));
    expect(api.delete).toHaveBeenCalledWith('/admin/connectors/c1');
  });

  it('shows the last failure, and the outcome of connecting an account', async () => {
    connectors = [
      connector({
        authMode: 'oauth',
        hasSharedCredential: false,
        oauthClientId: 'abc',
        oauthClientSource: 'dynamic',
        lastErrorAt: '2026-10-01T11:00:00.000Z',
        lastError: 'Docs did not respond in time.',
      }),
    ];
    await render('admin', '/admin/connectors?connected=docs');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Docs did not respond in time.');
    expect(text).toContain('client registered by OCI');
    expect(text).toContain('Your account is connected');
    expect(findButton('Connect your account')).toBeDefined();
  });

  it('is read-only for auditors', async () => {
    await render('auditor');
    for (const name of ['Add connector', 'Test connection', 'Refresh tools', 'Delete Docs'])
      expect(findButton(name), name).toBeUndefined();
    const toggle = document.getElementById('connector-tool-t1') as HTMLButtonElement;
    expect(toggle.closest('fieldset')?.disabled).toBe(true);
  });
});

describe('connector form changes', () => {
  const saved = connector();
  const draft = {
    name: 'Docs',
    url: saved.url,
    authMode: 'shared' as const,
    sharedHeaderName: 'Authorization',
    oauthClientId: '',
    oauthScopes: '',
    enabled: true,
    allowPrivateNetwork: false,
  };
  it('sends only what changed, and secrets only when replaced or cleared', () => {
    const keep = { sharedHeaderValue: ['keep', ''], oauthClientSecret: ['keep', ''] } as const;
    expect(connectorChanges(saved, draft, { ...keep })).toEqual({});
    expect(
      connectorChanges(
        saved,
        { ...draft, name: ' Wiki ' },
        {
          sharedHeaderValue: ['replace', 'Bearer new'],
          oauthClientSecret: ['clear', ''],
        },
      ),
    ).toEqual({ name: 'Wiki', sharedHeaderValue: 'Bearer new', oauthClientSecret: null });
    // A dynamically registered client is not cleared by an empty field.
    expect(
      connectorChanges({ ...saved, oauthClientId: 'dyn', oauthClientSource: 'dynamic' }, draft, {
        ...keep,
      }),
    ).toEqual({});
  });

  it('groups role tools by connector after the built-in ones', () => {
    expect(
      toolGroups([
        {
          id: 'mcp__b__x',
          label: 'X',
          kind: 'read',
          source: 'connector',
          allowed: false,
          connector: 'B',
        },
        { id: 'web_search', label: 'Web search', kind: 'read', source: 'builtin', allowed: true },
        {
          id: 'mcp__a__y',
          label: 'Y',
          kind: 'write',
          source: 'connector',
          allowed: false,
          connector: 'A',
        },
      ]).map((group) => [group.connector, group.tools.map((tool) => tool.id)]),
    ).toEqual([
      [null, ['web_search']],
      ['A', ['mcp__a__y']],
      ['B', ['mcp__b__x']],
    ]);
  });
});
