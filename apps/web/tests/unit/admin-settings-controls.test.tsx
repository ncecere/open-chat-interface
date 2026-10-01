// @vitest-environment happy-dom
import type { InstanceSettings } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthenticationSettingsForm } from '../../src/routes/admin/settings/authentication-settings';
import { GeneralSettings } from '../../src/routes/admin/settings/general-settings';
import { cleanup, click, renderAdmin, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setColorTheme: vi.fn() }),
}));

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ models: [] });
  api.patch.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function submitButton(form: HTMLFormElement): HTMLButtonElement {
  return form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

it('no longer offers the Canvas and MCP toggles, and never sends them', async () => {
  const settings = {
    colorTheme: 'neutral',
    defaultSystemPrompt: null,
    search: {
      enabled: true,
      provider: 'searxng',
      baseUrl: 'http://search.test',
      hasCredential: false,
    },
    storage: { driver: 'local' },
    features: {
      shareLinks: true,
      temporaryChat: true,
      canvas: true,
      mcp: true,
      webSearch: true,
      attachments: true,
      branching: true,
    },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<GeneralSettings settings={settings} />));

  expect(document.getElementById('feature-canvas')).toBeNull();
  expect(document.getElementById('feature-mcp')).toBeNull();
  expect(document.body.textContent).not.toContain('MCP tools');
  expect(document.body.textContent).not.toContain('Canvas');

  const shareLinks = document.getElementById('feature-shareLinks') as HTMLButtonElement;
  await click(shareLinks);
  await click(submitButton(shareLinks.closest('form')!));
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', { features: { shareLinks: false } });
});

it('keeps session length but drops the unused session extension field', async () => {
  ({ root } = await renderAdmin(
    <AuthenticationSettingsForm
      initialSettings={{
        registrationMode: 'open',
        emailVerificationRequired: false,
        localAuthEnabled: true,
        sessionLifetimeDays: 30,
      }}
      smtpConfigured
    />,
  ));

  expect(document.getElementById('session-refresh')).toBeNull();
  expect(document.body.textContent).not.toContain('Extend after');

  const lifetime = document.getElementById('session-lifetime') as HTMLInputElement;
  expect(lifetime.value).toBe('30');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(lifetime, '14');
    lifetime.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await click(submitButton(lifetime.closest('form')!));
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', { sessionLifetimeDays: 14 });
});
