// @vitest-environment happy-dom
import { type InstanceSettings, updateInstanceSettingsSchema } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthenticationSettingsForm } from '../../src/routes/admin/settings/authentication-settings';
import { GeneralSettings } from '../../src/routes/admin/settings/general-settings';
import { buttonNames, cleanup, click, renderAdmin, settle } from './admin-test-utils';

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

it('lists the instance feature switches and sends the full features object', async () => {
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
      webSearch: false,
      attachments: true,
      branching: true,
    },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<GeneralSettings settings={settings} />));

  // Moved: web search to its own page, the default model to Providers &
  // models, and the accent to Branding.
  expect(document.getElementById('feature-webSearch')).toBeNull();
  expect(document.getElementById('default-model')).toBeNull();
  expect(document.querySelector('input[name="color-theme"]')).toBeNull();

  const shareLinks = document.getElementById('feature-shareLinks') as HTMLButtonElement;
  await click(shareLinks);
  await click(submitButton(shareLinks.closest('form')!));
  // The server replaces the stored object, so unlisted values (including web
  // search, switched elsewhere) are sent back exactly as loaded.
  expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
    features: {
      shareLinks: false,
      temporaryChat: true,
      webSearch: false,
      attachments: true,
      branching: true,
    },
  });
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

it('saves the default reasoning level on its own', async () => {
  const settings = {
    defaultSystemPrompt: 'Keep it short.',
    defaultEffort: 'instant',
    storage: { driver: 'local' },
    features: {
      shareLinks: false,
      temporaryChat: true,
      webSearch: false,
      attachments: false,
      branching: true,
    },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<GeneralSettings settings={settings} />));

  // The shared Select, as on every other admin page, not the native one (#305).
  const select = document.getElementById('default-effort') as HTMLButtonElement;
  expect(select.tagName).toBe('BUTTON');
  expect(select.getAttribute('role')).toBe('combobox');
  expect(select.textContent).toContain('Instant');
  // Described by the Field's hint, as the native select was (#295).
  expect(select.getAttribute('aria-describedby')).toContain('default-effort-hint');
  await click(select);
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options().map((option) => option.textContent)).toEqual([
    'Instant',
    'Low',
    'Medium',
    'High',
  ]);
  const save = submitButton(select.closest('form')!);
  expect(save.disabled).toBe(true);

  await click(options().find((option) => option.textContent === 'Medium')!);
  await settle();
  expect(select.textContent).toContain('Medium');
  await click(save);

  // Only the level is sent, so the system prompt and features stay as stored.
  expect(api.patch).toHaveBeenCalledExactlyOnceWith('/admin/settings', { defaultEffort: 'medium' });
  const parsed = updateInstanceSettingsSchema.safeParse(api.patch.mock.calls[0]?.[1]);
  expect(parsed.success && parsed.data).toEqual({ defaultEffort: 'medium' });
});

it('names each Save changes button for what it saves (#175)', async () => {
  const settings = {
    defaultSystemPrompt: null,
    defaultEffort: 'instant',
    maxToolSteps: 8,
    autoCompact: true,
    diagramGuidance: true,
    storage: { driver: 'local' },
    features: {
      shareLinks: false,
      temporaryChat: true,
      webSearch: false,
      attachments: false,
      branching: true,
    },
  } as unknown as InstanceSettings;
  ({ root } = await renderAdmin(<GeneralSettings settings={settings} />));
  const saves = [...document.querySelectorAll('button')].filter(
    (candidate) => candidate.textContent?.trim() === 'Save changes',
  );
  const names = buttonNames().filter((name) => name.startsWith('Save changes'));
  expect(saves).toHaveLength(6);
  expect(names).toEqual([
    'Save changes to the system instructions',
    'Save changes to the default reasoning level',
    'Save changes to the tool step limit',
    'Save changes to conversation summaries',
    'Save changes to editorial diagrams',
    'Save changes to the features',
  ]);
});
