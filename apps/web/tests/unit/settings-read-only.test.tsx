// @vitest-environment happy-dom
import { INACTIVE_READ_ONLY_STATUS, type ReadOnlyStatus } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setReadOnlyStatus } from '../../src/lib/read-only';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsAccountPage } from '../../src/routes/settings/account';
import { SettingsAttachmentsPage } from '../../src/routes/settings/attachments';
import { SettingsConnectorsPage } from '../../src/routes/settings/connectors';
import { SettingsCustomizationPage } from '../../src/routes/settings/customization';
import { SettingsHistoryPage } from '../../src/routes/settings/history';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { SettingsModelsPage } from '../../src/routes/settings/models';
import { button, cleanup, click, dialog, renderAdmin, settle } from './admin-test-utils';

/**
 * Every Settings control that saves something is off while the instance is
 * read-only, with the reason as its title, as the sidebar's and the header's
 * are (#331, #353). "Edit name", "Change Password" and History's import were
 * enabled and refused only after the person filled the form in. The real
 * pages, query client, router and read-only store run here; only the API's
 * answers are fixed.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
// Settings is not under the administration layout, whose access context would
// turn the confirm buttons off by itself while read-only: as outside it, every
// person may edit, and only the page's own lock applies.
vi.mock('../../src/components/admin/admin-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/admin/admin-access')>()),
  useAdminAccess: () => ({ role: 'admin', canEdit: true, maintenance: false }),
}));
const authClient = vi.hoisted(() => ({ changePassword: vi.fn(), updateUser: vi.fn() }));
vi.mock('../../src/lib/auth-client', () => ({ authClient }));

const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Walk8 settings check',
  until: new Date(Date.now() + 60 * 60_000).toISOString(),
  window: null,
};
const REASON = /^Read-only for maintenance until about /;

const now = new Date().toISOString();
const thread = (id: string, title: string, archived = false) => ({
  id,
  title,
  pinned: false,
  archived,
  temporary: false,
  expiresAt: null,
  parentThreadId: null,
  branchedFromMessageId: null,
  projectId: null,
  lastMessageAt: now,
  createdAt: now,
  updatedAt: now,
});
const memory = (id: string, content: string) => ({
  id,
  content,
  source: 'person',
  threadId: null,
  createdAt: now,
  updatedAt: now,
});
const model = (slug: string, isDefault: boolean) => ({
  id: slug,
  slug,
  displayName: slug,
  description: null,
  providerId: 'p',
  providerKind: 'openai-compatible',
  providerLabel: 'Provider',
  upstreamModelId: slug,
  capabilities: [],
  labId: null,
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault,
  sortOrder: 0,
});

let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.test',
          role: 'user',
          emailVerified: true,
        },
        preferences: { displayName: 'Ada', occupation: null, traits: [], additionalContext: null },
        features: { accountDeletion: true, projects: true },
        chat: { defaultEffort: 'low', instanceDefaultEffort: 'low', reasoningEfforts: ['low'] },
        signIn: { password: true, credential: true, sso: [] },
      };
    if (path === '/me/sessions') return { sessions: [] };
    if (path === '/me/imports')
      return {
        imports: [
          {
            id: 'i1',
            filename: 'export.zip',
            status: 'completed',
            source: 'chatgpt',
            formatVersion: null,
            sizeBytes: 2048,
            createdAt: now,
            importedCount: 2,
            skippedCount: 0,
            failedCount: 0,
            warnings: [],
            error: null,
          },
        ],
      };
    if (path === '/projects') return { projects: [] };
    if (path.startsWith('/threads?')) {
      const archived = new URLSearchParams(path.slice('/threads?'.length)).get('archived');
      return {
        threads: [archived ? thread('z1', 'Old plan', true) : thread('t1', 'Lab report')],
        nextCursor: null,
      };
    }
    if (path === '/threads/trash')
      return {
        threads: [
          {
            ...thread('d1', 'Deleted plan'),
            messageCount: 3,
            deletedAt: now,
            deletedReason: 'person',
            purgeAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          },
        ],
      };
    if (path === '/memory')
      return {
        enabled: true,
        available: true,
        entries: [memory('m1', 'Teaches chemistry')],
        limits: { maxEntries: 200, maxChars: 500 },
      };
    if (path === '/models') return { models: [model('everyday', true), model('other', false)] };
    if (path === '/connectors')
      return {
        connectors: [
          {
            id: 'c1',
            name: 'Docs',
            slug: 'docs',
            connected: true,
            needsReconnect: false,
            toolCount: 2,
          },
          {
            id: 'c2',
            name: 'Mail',
            slug: 'mail',
            connected: false,
            needsReconnect: false,
            toolCount: 1,
          },
        ],
      };
    if (path === '/attachments')
      return {
        attachments: [
          {
            id: 'a1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 2048,
            url: '/api/attachments/a1/content',
            thumbnailUrl: null,
            createdAt: now,
            project: null,
            unsent: false,
          },
        ],
      };
    if (path === '/attachments/usage')
      return {
        liveBytes: 2048,
        liveFileCount: 1,
        pendingBytes: 0,
        pendingFileCount: 0,
        artifactBytes: 0,
        breakdown: {
          chatFiles: { bytes: 2048, count: 1 },
          projectFiles: { bytes: 0, count: 0 },
          artifacts: { bytes: 0, count: 0 },
        },
        maxTotalBytes: null,
        maxFileCount: null,
        maxFileBytes: null,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  for (const method of [api.post, api.put, api.patch, api.delete])
    method.mockReset().mockResolvedValue({ ok: true });
  authClient.changePassword.mockReset().mockResolvedValue({ data: {}, error: null });
  authClient.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(async () => {
  setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS);
  if (root) await cleanup(root);
  root = undefined;
  localStorage.clear();
});

const render = async (ui: React.ReactNode, path: string) => {
  ({ root } = await renderAdmin(ui, { path }));
};
const off = (name: string) => {
  const control = button(name);
  expect(control.disabled, name).toBe(true);
  expect(control.title, name).toMatch(REASON);
};
const on = (name: string) => expect(button(name).disabled, name).toBe(false);
async function readOnlyBegins() {
  await act(async () => setReadOnlyStatus(ON));
  await settle();
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(prototype.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Settings → Account while read-only (#353)', () => {
  it('turns off Edit name, Change Password and Delete account, and back on afterwards', async () => {
    setReadOnlyStatus(ON);
    await render(<SettingsAccountPage />, '/settings');
    for (const name of ['Edit name', 'Change Password', 'Delete account']) off(name);
    // Signing out of devices is allowed in maintenance: it stays on.
    on('View Devices');

    await act(async () => setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS));
    await settle();
    for (const name of ['Edit name', 'Change Password', 'Delete account']) on(name);
  });

  it('turns off Save and Change password in a form left open when read-only starts', async () => {
    await render(<SettingsAccountPage />, '/settings');
    await click(button('Edit name'));
    await type(document.querySelector<HTMLInputElement>('input[autocomplete="name"]')!, 'Ada L');
    await click(button('Change Password'));
    expect(button('Change password').disabled).toBe(false);

    await readOnlyBegins();
    off('Change password');
    off('Save');
    expect(authClient.changePassword).not.toHaveBeenCalled();
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });

  it('turns off the confirmation of deleting the account', async () => {
    await render(<SettingsAccountPage />, '/settings');
    await click(button('Delete account'));
    await type(
      document.getElementById('delete-account-confirm') as HTMLInputElement,
      'ada@example.test',
    );
    await type(document.getElementById('delete-account-password') as HTMLInputElement, 'secret');
    expect(button('Delete my account').disabled).toBe(false);
    await readOnlyBegins();
    expect(button('Delete my account').disabled).toBe(true);
  });
});

describe('Settings → History while read-only (#353)', () => {
  it('turns off choosing an import file, and removing an import, and says why in the dialog', async () => {
    setReadOnlyStatus(ON);
    await render(<SettingsHistoryPage />, '/settings/history');
    await click(button('Import from ChatGPT or Claude'));
    off('Choose export file');
    off('Remove export.zip');
    expect(dialog()?.textContent).toContain('importing is paused until maintenance ends');
    expect(dialog()?.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    // Looking at what was imported stays possible.
    expect(dialog()?.textContent).toContain('export.zip');

    await act(async () => setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS));
    await settle();
    on('Choose export file');
    on('Remove export.zip');
  });

  it('turns off archiving, deleting and restoring conversations', async () => {
    await render(<SettingsHistoryPage />, '/settings/history');
    await click(document.querySelector<HTMLInputElement>('input[aria-label="Select Lab report"]')!);
    on('Archive');
    on('Delete');
    await readOnlyBegins();
    off('Archive');
    off('Delete');

    await click([...document.querySelectorAll<HTMLElement>('[role="tab"]')][1]!);
    off('Restore Old plan');
    await click([...document.querySelectorAll<HTMLElement>('[role="tab"]')][2]!);
    for (const name of ['Empty trash', 'Restore Deleted plan', 'Delete Deleted plan now'])
      off(name);
  });
});

describe('Settings → Memory while read-only (#353)', () => {
  it('turns off Add, Edit, Delete, Delete all and the switch', async () => {
    setReadOnlyStatus(ON);
    await render(<SettingsMemoryPage />, '/settings/memory');
    await type(document.getElementById('memory-new') as HTMLTextAreaElement, 'A new note');
    for (const name of [
      'Add',
      'Edit memory: Teaches chemistry',
      'Delete memory: Teaches chemistry',
      'Delete all…',
    ])
      off(name);
    const toggle = document.getElementById('memory-enabled') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toMatch(REASON);

    await act(async () => setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS));
    await settle();
    for (const name of [
      'Add',
      'Edit memory: Teaches chemistry',
      'Delete memory: Teaches chemistry',
      'Delete all…',
    ])
      on(name);
    expect(toggle.disabled).toBe(false);
  });

  it('turns off Save in an edit left open, and the confirmations', async () => {
    await render(<SettingsMemoryPage />, '/settings/memory');
    await click(button('Edit memory: Teaches chemistry'));
    await type(
      document.getElementById(
        document.querySelector('label.sr-only')!.getAttribute('for')!,
      ) as HTMLTextAreaElement,
      'Teaches physics',
    );
    on('Save');
    await readOnlyBegins();
    off('Save');
  });
});

describe('the other Settings pages while read-only (#353)', () => {
  it('turns off Save defaults once something is chosen', async () => {
    await render(<SettingsModelsPage />, '/settings/models');
    await click(document.getElementById('default-model') as HTMLButtonElement);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === 'other',
      )!,
    );
    on('Save defaults');
    await readOnlyBegins();
    off('Save defaults');
  });

  it('turns off Save Preferences once something is changed', async () => {
    await render(
      <ThemeProvider>
        <SettingsCustomizationPage />
      </ThemeProvider>,
      '/settings/customization',
    );
    await type(document.getElementById('occupation') as HTMLInputElement, 'Chemist');
    on('Save Preferences');
    await readOnlyBegins();
    off('Save Preferences');
  });

  it('turns off Connect and Disconnect', async () => {
    setReadOnlyStatus(ON);
    await render(<SettingsConnectorsPage />, '/settings/connectors');
    off('Disconnect Docs');
    off('Connect Mail');
  });

  it('turns off deleting attachments, one or several', async () => {
    await render(<SettingsAttachmentsPage />, '/settings/attachments');
    on('Delete notes.txt');
    await click(document.querySelector<HTMLInputElement>('input[aria-label="Select notes.txt"]')!);
    on('Delete (1)');
    await readOnlyBegins();
    off('Delete notes.txt');
    off('Delete (1)');
  });
});
