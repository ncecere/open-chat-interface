// @vitest-environment happy-dom
import type { CatalogModel, UserConnector } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_HINT_STORAGE_KEY,
  ComposerConnectHint,
  connectorToSuggest,
} from '../../src/components/chat/composer-connect-hint';
import { cleanup, click, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const model = (capabilities: CatalogModel['capabilities']): CatalogModel => ({
  id: 'm1',
  slug: 'm1',
  displayName: 'Model',
  description: null,
  providerId: 'gateway',
  providerKind: 'openai-compatible',
  providerLabel: 'Gateway',
  upstreamModelId: 'm1',
  capabilities,
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: false,
  sortOrder: 0,
});
const withTools = model(['tool_calling']);
const connector = (overrides: Partial<UserConnector> = {}): UserConnector => ({
  id: 'c-docs',
  name: 'Docs',
  slug: 'docs',
  connected: false,
  needsReconnect: false,
  toolCount: 2,
  ...overrides,
});

let root: Root | undefined;
let connectors: UserConnector[];
beforeEach(() => {
  localStorage.clear();
  connectors = [connector()];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/connectors') return { connectors };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (selectedModel: CatalogModel | null = withTools) => {
  // A query client and a router, as in the app.
  ({ root } = await renderAdmin(<ComposerConnectHint selectedModel={selectedModel} />));
};
const hint = () => document.querySelector<HTMLElement>('[role="note"]');

describe('Composer connect hint', () => {
  it('suggests connecting an unconnected connector, linking to Settings → Connectors', async () => {
    await render();
    const note = hint();
    expect(note).not.toBeNull();
    expect(note?.getAttribute('aria-label')).toBe('Connect Docs');
    expect(note?.textContent).toBe('Connect Docs to let the model use its tools.');
    const link = note?.querySelector('a');
    expect(link?.textContent).toBe('Connect Docs');
    expect(link?.getAttribute('href')).toBe('/settings/connectors');
    // Both controls are native, so they are reachable and operable by keyboard.
    const dismiss = note?.querySelector('button');
    expect(dismiss?.getAttribute('type')).toBe('button');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss: connect Docs');
  });

  it('says Reconnect when the connection expired', async () => {
    connectors = [connector({ needsReconnect: true })];
    await render();
    expect(hint()?.querySelector('a')?.textContent).toBe('Reconnect Docs');
  });

  it('shows nothing, and asks for nothing, when the model cannot call tools', async () => {
    await render(model(['reasoning']));
    expect(hint()).toBeNull();
    await cleanup(root!);
    await render(null);
    expect(hint()).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows nothing when everything is connected or nothing may be used', async () => {
    connectors = [connector({ connected: true })];
    await render();
    expect(hint()).toBeNull();
    await cleanup(root!);
    connectors = [];
    await render();
    expect(hint()).toBeNull();
  });

  it('remembers a dismissal per connector and then suggests the next one', async () => {
    connectors = [connector(), connector({ id: 'c-tickets', name: 'Tickets', slug: 'tickets' })];
    await render();
    expect(hint()?.getAttribute('aria-label')).toBe('Connect Docs');
    await click(hint()!.querySelector('button')!);
    expect(JSON.parse(localStorage.getItem(CONNECTOR_HINT_STORAGE_KEY)!)).toEqual(['c-docs']);
    expect(hint()?.getAttribute('aria-label')).toBe('Connect Tickets');

    // Still dismissed after a reload.
    await cleanup(root!);
    await render();
    expect(hint()?.getAttribute('aria-label')).toBe('Connect Tickets');
    await click(hint()!.querySelector('button')!);
    expect(hint()).toBeNull();
  });

  it('ignores unreadable stored dismissals', async () => {
    localStorage.setItem(CONNECTOR_HINT_STORAGE_KEY, '{not json');
    await render();
    expect(hint()).not.toBeNull();
  });

  it('picks the first unconnected, undismissed connector with tools', () => {
    const list = [
      connector({ id: 'a', connected: true }),
      connector({ id: 'b', toolCount: 0 }),
      connector({ id: 'c' }),
      connector({ id: 'd' }),
    ];
    expect(connectorToSuggest(list, [])?.id).toBe('c');
    expect(connectorToSuggest(list, ['c'])?.id).toBe('d');
    expect(connectorToSuggest(list, ['c', 'd'])).toBeNull();
  });
});
