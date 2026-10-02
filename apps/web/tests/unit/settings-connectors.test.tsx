// @vitest-environment happy-dom
import type { UserConnector } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsConnectorsPage } from '../../src/routes/settings/connectors';
import { cleanup, click, findButton, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const docs: UserConnector = {
  id: 'c1',
  name: 'Docs',
  slug: 'docs',
  connected: false,
  needsReconnect: false,
  toolCount: 2,
};

let root: Root | undefined;
let connectors: UserConnector[];
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  connectors = [docs];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/connectors') return { connectors };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post
    .mockReset()
    .mockResolvedValue({ authorizationUrl: 'https://auth.example.test/authorize?x=1' });
  api.delete.mockReset().mockResolvedValue({ ok: true, revoked: true });
  assign = vi.fn();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

// The page needs a router and a query client like the admin pages do.
const render = async (path = '/settings/connectors') => {
  ({ root } = await renderAdmin(<SettingsConnectorsPage />, { path }));
};

describe('Settings → Connectors', () => {
  it('offers Connect for a connector the person has not connected, and starts signing in', async () => {
    await render();
    expect(document.body.textContent).toContain('Not connected');
    expect(document.body.textContent).toContain('Connect Docs to let models use its 2 tools');
    await click(findButton('Connect Docs')!);
    expect(api.post).toHaveBeenCalledWith('/connectors/c1/connect', { returnTo: 'settings' });
    expect(assign).toHaveBeenCalledWith('https://auth.example.test/authorize?x=1');
  });

  it('shows a connected account with Disconnect', async () => {
    connectors = [{ ...docs, connected: true }];
    await render('/settings/connectors?connected=docs');
    expect(document.body.textContent).toContain('Docs is connected.');
    expect(findButton('Connect Docs')).toBeUndefined();
    await click(findButton('Disconnect Docs')!);
    expect(api.delete).toHaveBeenCalledWith('/connectors/c1/account');
  });

  it('asks to reconnect an expired connection, and explains a failed sign-in', async () => {
    connectors = [{ ...docs, needsReconnect: true }];
    await render('/settings/connectors?error=state');
    expect(document.body.textContent).toContain('Connection expired');
    expect(findButton('Connect Docs')?.textContent).toContain('Reconnect');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'That sign-in link was not valid any more',
    );
  });

  it('says when there is nothing to connect', async () => {
    connectors = [];
    await render();
    expect(document.body.textContent).toContain('There is nothing for you to connect.');
  });
});
